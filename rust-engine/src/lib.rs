#![no_std]

use core::panic::PanicInfo;

#[panic_handler]
fn panic_handler(_: &PanicInfo) -> ! {
    loop {}
}

const SIZE: i32 = 15;
const N: usize = (SIZE * SIZE) as usize; // 225
const BLACK: u8 = 1;
const WHITE: u8 = 2;
const MATE: i32 = 1_000_000;
const INF: i32 = 1_000_000_000;
/// 叶节点 VCF 静态延伸的攻击手预算。0 = 关闭。
/// A/B 实测（scripts/eval.mjs，16 局 400ms）：QMAX=6 时 7:9、QMAX=3 时 6:10
/// 均负于关闭——强制挡点机制本就精确解析进行中的四战，成四延伸的边际收益
/// 抵不上主搜索深度损失（5.2→4.5）。长时控（≥2s）下可重启实验。
const VCF_QMAX: i32 = 0;

const DIRS: [(i32, i32); 4] = [(1, 0), (0, 1), (1, 1), (1, -1)]; // (dx, dy)
// 2026-09-09 texel 调参（Rapfi 300 局自对弈 1434 局面拟合 + 100 局对打筛选）：小窗口权重大幅
// 压缩——1/2 子窗计数与胜负相关性仅 -0.05/-0.01，3/4 子窗 0.23/0.31。与 TS 侧默认 W 同步。
const W: [i32; 6] = [0, 1, 8, 96, 600, 1_000_000];

extern "C" {
    fn now() -> f64;
}

#[inline]
fn in_bounds(r: i32, c: i32) -> bool {
    r >= 0 && r < SIZE && c >= 0 && c < SIZE
}
#[inline]
fn idx(r: i32, c: i32) -> usize {
    (r * SIZE + c) as usize
}

// ---------------------------------------------------------------- Zobrist

const fn zobrist_table() -> [u32; N * 3] {
    let mut arr = [0u32; N * 3];
    let mut x = 0x9e3779b9u32;
    let mut i = 0;
    while i < N * 3 {
        x = x.wrapping_mul(1664525).wrapping_add(1013904223);
        arr[i] = x;
        i += 1;
    }
    arr
}
static ZOBRIST: [u32; N * 3] = zobrist_table();
static COLOR_SALT: [u32; 3] = [0, 0x3c6ef372, 0xa54ff53a];

#[inline]
fn zobrist_at(i: usize, stone: u8) -> u32 {
    ZOBRIST[i * 3 + stone as usize]
}

// ---------------------------------------------------------------- 置换表

// 100 万项 × 16B = 16MB（零初始化 BSS，不增大 wasm 文件）。
// 10 秒级搜索会展开百万级节点，65K 项的小表碰撞频繁、命中率低，直接拖累迭代加深的层数。
const TT_SIZE: usize = 1 << 20;
const TT_MASK: usize = TT_SIZE - 1;

// ---------------------------------------------------------------- 全局搜索状态
//
// Lazy SMP 内存模型：所有 worker 实例共享同一线性内存（JS 以 WebAssembly.Memory
// shared 创建并注入），但 mutable global 是每实例独立的——THREAD_BASE 即利用这一点：
// 每实例把自己的"线程状态区"指到共享内存中的专属分区，实现 per-thread 搜索状态。
// 栈冲突由 JS 在实例化后把每实例的 __stack_pointer（同为每实例 global）移到专属区解决。
//
// 共享（数据段，全实例同一地址）：
//   - ZOBRIST / COLOR_SALT：只读表
//   - TT_A / TT_B：置换表（双 u64 原子，写序 score→meta(Release)/读序 meta(Acquire)→score，
//     撕裂读表现为 key 不匹配被探测拒绝——Lazy SMP 标准做法）
//   - SMP_*：线程协调（GO/STOP/参数）
// 每线程（THREAD_BASE 指向的 ThreadState）：棋盘/增量表/杀手着/历史/结果。

use core::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};

#[repr(C)]
struct ThreadState {
    BOARD: [u8; N],
    HASH: u32,
    NODES: u32,
    DEADLINE: f64,
    TIMED_OUT: bool,
    KILLERS: [[u16; 2]; 64],
    HISTORY: [i32; N],
    NEAR: [u16; N],
    FIVE_B: [i16; N],
    FIVE_W: [i16; N],
    FIVE_B_MASK: [u64; 4],
    FIVE_W_MASK: [u64; 4],
    FIVE_B_CELLS: i32,
    FIVE_W_CELLS: i32,
    F3_B: [i16; N],
    F3_W: [i16; N],
    F3_B_MASK: [u64; 4],
    F3_W_MASK: [u64; 4],
    F3_B_CELLS: i32,
    F3_W_CELLS: i32,
    RESULT_SCORE: i32,
    RESULT_DEPTH: i32,
    RESULT_NODES: i32,
    RESULT_TIMED_OUT: i32,
    EVAL_SCORE: i32,
    MAX_PLY: i32,
    MOVES_BUF: [u16; 64],
}

/** 每实例线程状态区基址（mutable global → 每 worker 实例独立）。smp_init 设置。 */
static mut THREAD_BASE: u32 = 0;

fn ts() -> &'static mut ThreadState {
    unsafe { &mut *(THREAD_BASE as *mut ThreadState) }
}

// ---- 共享置换表：每槽 try-lock 三字结构（Lazy SMP 并发安全） ----
// v1（meta 先写）：并发写同槽时读者可把线程1的 score 配线程2的 flag/depth ——
// 同局面不同深度的条目混配产生非法剪枝（实测棋力 -147 Elo）。
// v2（key+score 同字）：挡掉异局面混配，但同局面的 score/flag 仍可错配。
// v3（本版）：每槽一个锁字，probe/store 以 try-lock（CAS 0→1）进入，
// 锁内读写完整三元组（A/META/无效字），锁竞争即放弃该条目（miss / 丢弃 store）——
// 无自旋无死锁，最坏情形退化为命中率损失。
// TT_A[i] = key(32) | score(32)；TT_META[i] = key低24 | depth偏置8 | flag8 | best_move16。
static TT_LOCK: [AtomicU32; TT_SIZE] = [const { AtomicU32::new(0) }; TT_SIZE];
static TT_A: [AtomicU64; TT_SIZE] = [const { AtomicU64::new(0) }; TT_SIZE];
static TT_META: [AtomicU64; TT_SIZE] = [const { AtomicU64::new(0) }; TT_SIZE];

#[inline]
fn tt_try_lock(i: usize) -> bool {
    TT_LOCK[i].compare_exchange(0, 1, Ordering::Acquire, Ordering::Relaxed).is_ok()
}

#[inline]
fn tt_unlock(i: usize) {
    TT_LOCK[i].store(0, Ordering::Release);
}

fn tt_clear() {
    if SMP_KEEP_TT.load(Ordering::Relaxed) {
        return;
    }
    for i in 0..TT_SIZE {
        if tt_try_lock(i) {
            TT_A[i].store(0, Ordering::Relaxed);
            TT_META[i].store(0, Ordering::Relaxed);
            tt_unlock(i);
        }
    }
}

// ---- SMP 线程协调（共享） ----
static SMP_GO: AtomicBool = AtomicBool::new(false);
/** SMP 模式跳过每手 tt_clear（跨手 TT 复用 = Lazy SMP 主要增益；hash 寻址保证旧条目天然 miss） */
static SMP_KEEP_TT: AtomicBool = AtomicBool::new(false);
static SMP_STOP: AtomicBool = AtomicBool::new(false);
/** [color, max_depth, time_ms, width] */
static SMP_PARAMS: [AtomicU32; 4] = [const { AtomicU32::new(0) }; 4];

#[no_mangle]
pub extern "C" fn board_buffer() -> *mut u8 {
    let ctx = ts();
    unsafe { ctx.BOARD.as_mut_ptr() }
}
#[no_mangle]
pub extern "C" fn get_score() -> i32 {
    let ctx = ts();
    unsafe { ctx.RESULT_SCORE }
}
#[no_mangle]
pub extern "C" fn get_depth() -> i32 {
    let ctx = ts();
    unsafe { ctx.RESULT_DEPTH }
}
#[no_mangle]
pub extern "C" fn get_nodes() -> i32 {
    let ctx = ts();
    unsafe { ctx.RESULT_NODES }
}
#[no_mangle]
pub extern "C" fn get_timed_out() -> i32 {
    let ctx = ts();
    unsafe { ctx.RESULT_TIMED_OUT }
}
/** 调试：增量评估与全盘重算的差值（0 = 一致）。搜索结束后调用以验证不变量。 */
#[no_mangle]
pub extern "C" fn eval_consistency() -> i32 {
    let ctx = ts();
    unsafe { ctx.EVAL_SCORE - evaluate(&ctx.BOARD) }
}
/** 搜索到达的最大 ply（威胁延伸后可达名义深度数倍） */
#[no_mangle]
pub extern "C" fn get_seldepth() -> i32 {
    let ctx = ts();
    unsafe { ctx.MAX_PLY }
}
/** 调试：四威胁/成四点表与全盘重算的不一致格数（0 = 一致）。搜索结束后调用。 */
#[no_mangle]
pub extern "C" fn five_consistency() -> i32 {
    let ctx = ts();
    unsafe {
        let b = ctx.FIVE_B;
        let w = ctx.FIVE_W;
        let bc = ctx.FIVE_B_CELLS;
        let wc = ctx.FIVE_W_CELLS;
        let b3 = ctx.F3_B;
        let w3 = ctx.F3_W;
        let bc3 = ctx.F3_B_CELLS;
        let wc3 = ctx.F3_W_CELLS;
        build_five_tables(ctx, );
        let mut bad = 0i32;
        for i in 0..N {
            if ctx.FIVE_B[i] != b[i] || ctx.FIVE_W[i] != w[i] {
                bad += 1;
            }
            if ctx.F3_B[i] != b3[i] || ctx.F3_W[i] != w3[i] {
                bad += 10000;
            }
        }
        if ctx.FIVE_B_CELLS != bc || ctx.FIVE_W_CELLS != wc {
            bad += 1000;
        }
        if ctx.F3_B_CELLS != bc3 || ctx.F3_W_CELLS != wc3 {
            bad += 1000_000;
        }
        bad
    }
}

// ---------------------------------------------------------------- 胜负/禁手

fn find_winning_line(board: &[u8], r: i32, c: i32, color: u8, exact: bool) -> bool {
    for &(dx, dy) in DIRS.iter() {
        let mut cnt = 1;
        let (mut rr, mut cc) = (r + dy, c + dx);
        while in_bounds(rr, cc) && board[idx(rr, cc)] == color {
            cnt += 1;
            rr += dy;
            cc += dx;
        }
        let (mut rr, mut cc) = (r - dy, c - dx);
        while in_bounds(rr, cc) && board[idx(rr, cc)] == color {
            cnt += 1;
            rr -= dy;
            cc -= dx;
        }
        if if exact { cnt == 5 } else { cnt >= 5 } {
            return true;
        }
    }
    false
}

fn run_length(board: &[u8], r: i32, c: i32, color: u8) -> i32 {
    let mut best = 1;
    for &(dx, dy) in DIRS.iter() {
        let mut cnt = 1;
        let (mut rr, mut cc) = (r + dy, c + dx);
        while in_bounds(rr, cc) && board[idx(rr, cc)] == color {
            cnt += 1;
            rr += dy;
            cc += dx;
        }
        let (mut rr, mut cc) = (r - dy, c - dx);
        while in_bounds(rr, cc) && board[idx(rr, cc)] == color {
            cnt += 1;
            rr -= dy;
            cc -= dx;
        }
        if cnt > best {
            best = cnt;
        }
    }
    best
}

fn line_of(r: i32, c: i32, dx: i32, dy: i32) -> ([i32; 15], usize) {
    let mut cells = [0i32; 15];
    let mut n = 0;
    for i in -7..=7 {
        let rr = r + dy * i;
        let cc = c + dx * i;
        if in_bounds(rr, cc) {
            cells[n] = idx(rr, cc) as i32;
            n += 1;
        }
    }
    (cells, n)
}

fn line_pi(cells: &[i32; 15], n: usize, target: i32) -> i32 {
    for i in 0..n as i32 {
        if cells[i as usize] == target {
            return i;
        }
    }
    -1
}

// 四的棋子集合去重键（4 个黑子坐标排序后打包）
fn four_key(cells: &[i32; 15], start: i32, empty_idx: i32) -> u64 {
    let mut pos = [0i32; 4];
    let mut m = 0;
    for k in start..start + 5 {
        if k != empty_idx {
            pos[m] = cells[k as usize];
            m += 1;
        }
    }
    pos.sort_unstable();
    (pos[0] as u64) | ((pos[1] as u64) << 8) | ((pos[2] as u64) << 16) | ((pos[3] as u64) << 24)
}

fn count_fours(board: &[u8], r: i32, c: i32) -> i32 {
    let mut total = 0;
    for &(dx, dy) in DIRS.iter() {
        let (cells, n) = line_of(r, c, dx, dy);
        let pi = line_pi(&cells, n, idx(r, c) as i32);
        if pi < 0 {
            continue;
        }
        let mut seen = [0u64; 8];
        let mut seen_count = 0usize;
        let start0 = if pi - 4 > 0 { pi - 4 } else { 0 };
        let start1 = if pi < n as i32 - 5 { pi } else { n as i32 - 5 };
        let mut start = start0;
        while start <= start1 {
            let mut black = 0;
            let mut empty_idx = -1;
            let mut ok = true;
            for k in start..start + 5 {
                let s = board[cells[k as usize] as usize];
                if s == BLACK {
                    black += 1;
                } else if s == 0 {
                    empty_idx = k;
                } else {
                    ok = false;
                    break;
                }
            }
            if ok && black == 4 && empty_idx >= 0 {
                let before = if start - 1 >= 0 { board[cells[(start - 1) as usize] as usize] } else { WHITE };
                let after = if start + 5 < n as i32 { board[cells[(start + 5) as usize] as usize] } else { WHITE };
                if before != BLACK && after != BLACK {
                    let key = four_key(&cells, start, empty_idx);
                    let mut dup = false;
                    for j in 0..seen_count {
                        if seen[j] == key {
                            dup = true;
                            break;
                        }
                    }
                    if !dup && seen_count < 8 {
                        seen[seen_count] = key;
                        seen_count += 1;
                        total += 1;
                    }
                }
            }
            start += 1;
        }
    }
    total
}

// 三的棋子集合去重键（活四去掉成四点 ei 后的三个黑子）
fn three_key(cells: &[i32; 15], j: i32, ei: i32) -> u64 {
    let mut pos = [0i32; 3];
    let mut m = 0;
    for k in j..j + 4 {
        if k != ei {
            pos[m] = cells[k as usize];
            m += 1;
        }
    }
    pos.sort_unstable();
    (pos[0] as u64) | ((pos[1] as u64) << 8) | ((pos[2] as u64) << 16)
}

fn count_threes(board: &[u8], r: i32, c: i32, depth: i32) -> i32 {
    let mut total = 0;
    for &(dx, dy) in DIRS.iter() {
        let (cells, n) = line_of(r, c, dx, dy);
        let pi = line_pi(&cells, n, idx(r, c) as i32);
        if pi < 0 {
            continue;
        }
        let mut seen = [0u64; 8];
        let mut seen_count = 0usize;
        let ei0 = if pi - 3 > 0 { pi - 3 } else { 0 };
        let ei1 = if pi + 3 < n as i32 - 1 { pi + 3 } else { n as i32 - 1 };
        let mut ei = ei0;
        while ei <= ei1 {
            if ei == pi || board[cells[ei as usize] as usize] != 0 {
                ei += 1;
                continue;
            }
            let mut sim = [0u8; 15];
            for i in 0..n {
                sim[i as usize] = board[cells[i as usize] as usize];
            }
            sim[ei as usize] = BLACK;
            let mut found = false;
            let mut found_key = 0u64;
            let mut j = 0;
            while j < n as i32 - 3 && !found {
                if sim[j as usize] == BLACK
                    && sim[(j + 1) as usize] == BLACK
                    && sim[(j + 2) as usize] == BLACK
                    && sim[(j + 3) as usize] == BLACK
                {
                    let lo = if j - 1 >= 0 { sim[(j - 1) as usize] } else { WHITE };
                    let hi = if j + 4 < n as i32 { sim[(j + 4) as usize] } else { WHITE };
                    if lo == 0 && hi == 0 {
                        let lo2 = if j - 2 >= 0 { sim[(j - 2) as usize] } else { WHITE };
                        let hi2 = if j + 5 < n as i32 { sim[(j + 5) as usize] } else { WHITE };
                        if lo2 != BLACK && hi2 != BLACK {
                            if j <= pi && pi <= j + 3 && j <= ei && ei <= j + 3 {
                                if depth < 3 {
                                    let ei_idx = cells[ei as usize] as usize;
                                    let mut with_e = [0u8; N];
                                    for k in 0..N {
                                        with_e[k] = board[k];
                                    }
                                    with_e[ei_idx] = BLACK;
                                    let er = (ei_idx / 15) as i32;
                                    let ec = (ei_idx % 15) as i32;
                                    if check_forbidden(&with_e, er, ec, depth + 1) {
                                        j += 1;
                                        continue;
                                    }
                                }
                                found = true;
                                found_key = three_key(&cells, j, ei);
                            }
                        }
                    }
                }
                j += 1;
            }
            if found {
                let mut dup = false;
                for k in 0..seen_count {
                    if seen[k] == found_key {
                        dup = true;
                        break;
                    }
                }
                if !dup && seen_count < 8 {
                    seen[seen_count] = found_key;
                    seen_count += 1;
                    total += 1;
                }
            }
            ei += 1;
        }
    }
    total
}

fn check_forbidden(board: &[u8], r: i32, c: i32, depth: i32) -> bool {
    if find_winning_line(board, r, c, BLACK, true) {
        return false;
    }
    if run_length(board, r, c, BLACK) >= 6 {
        return true;
    }
    if count_fours(board, r, c) >= 2 {
        return true;
    }
    if depth < 3 && count_threes(board, r, c, depth) >= 2 {
        return true;
    }
    false
}

// ---------------------------------------------------------------- 终局/评估

fn is_winning_stone(board: &[u8], r: i32, c: i32, color: u8) -> bool {
    find_winning_line(board, r, c, color, color == BLACK)
}

fn evaluate(board: &[u8]) -> i32 {
    let mut score = 0;
    for r in 0..SIZE {
        for c in 0..(SIZE - 4) {
            let mut b = 0;
            let mut w = 0;
            for k in 0..5 {
                let s = board[idx(r, c + k)];
                if s == BLACK {
                    b += 1;
                } else if s == WHITE {
                    w += 1;
                }
            }
            if b > 0 && w > 0 {
                continue;
            }
            if b > 0 {
                score += W[b as usize];
            } else if w > 0 {
                score -= W[w as usize];
            }
        }
    }
    for r in 0..(SIZE - 4) {
        for c in 0..SIZE {
            let mut b = 0;
            let mut w = 0;
            for k in 0..5 {
                let s = board[idx(r + k, c)];
                if s == BLACK {
                    b += 1;
                } else if s == WHITE {
                    w += 1;
                }
            }
            if b > 0 && w > 0 {
                continue;
            }
            if b > 0 {
                score += W[b as usize];
            } else if w > 0 {
                score -= W[w as usize];
            }
        }
    }
    for r in 0..(SIZE - 4) {
        for c in 0..(SIZE - 4) {
            let mut b = 0;
            let mut w = 0;
            for k in 0..5 {
                let s = board[idx(r + k, c + k)];
                if s == BLACK {
                    b += 1;
                } else if s == WHITE {
                    w += 1;
                }
            }
            if b > 0 && w > 0 {
                continue;
            }
            if b > 0 {
                score += W[b as usize];
            } else if w > 0 {
                score -= W[w as usize];
            }
        }
    }
    for r in 0..(SIZE - 4) {
        for c in 4..SIZE {
            let mut b = 0;
            let mut w = 0;
            for k in 0..5 {
                let s = board[idx(r + k, c - k)];
                if s == BLACK {
                    b += 1;
                } else if s == WHITE {
                    w += 1;
                }
            }
            if b > 0 && w > 0 {
                continue;
            }
            if b > 0 {
                score += W[b as usize];
            } else if w > 0 {
                score -= W[w as usize];
            }
        }
    }
    score
}

// ---------------------------------------------------------------- 增量评估

/** 一个 5 连窗口的分值贡献（黑方视角）；黑白混合的窗口无价值 */
#[inline]
fn window_contribution(b: i32, w: i32) -> i32 {
    if b > 0 && w > 0 {
        0
    } else if b > 0 {
        W[b as usize]
    } else if w > 0 {
        -W[w as usize]
    } else {
        0
    }
}

/// ctx.BOARD[idx(r,c)] 已从 prev 变为当前值：重算所有经过该点的 5 连窗口，增量更新 ctx.EVAL_SCORE。
/// 落子后调 eval_delta(ctx, r, c, 0)；撤子后调 eval_delta(ctx, r, c, color)。
/// 禁手探测的临时放子/撤子不读 ctx.EVAL_SCORE，无需成对调用（净变化为零）。
fn eval_delta(ctx: &mut ThreadState, r: i32, c: i32, prev: u8) {
    unsafe {
        let new_v = ctx.BOARD[idx(r, c)];
        if prev == new_v {
            return;
        }
        let mut delta = 0i32;
        for &(dx, dy) in DIRS.iter() {
            // 枚举包含 (r,c) 的窗口：起点沿反方向回退 0..4
            for back in 0..5i32 {
                let sr = r - dy * back;
                let sc = c - dx * back;
                if !in_bounds(sr, sc) || !in_bounds(sr + dy * 4, sc + dx * 4) {
                    continue;
                }
                let mut old_b = 0;
                let mut old_w = 0;
                let mut new_b = 0;
                let mut new_w = 0;
                let mut old_e1: i32 = -1;
                let mut old_e2: i32 = -1;
                let mut new_e1: i32 = -1;
                let mut new_e2: i32 = -1;
                for k in 0..5i32 {
                    let kr = sr + dy * k;
                    let kc = sc + dx * k;
                    let ki = idx(kr, kc) as i32;
                    let v = ctx.BOARD[idx(kr, kc)];
                    let v_old = if kr == r && kc == c { prev } else { v };
                    let v_new = if kr == r && kc == c { new_v } else { v };
                    if v_old == BLACK {
                        old_b += 1;
                    } else if v_old == WHITE {
                        old_w += 1;
                    } else if old_e1 < 0 {
                        old_e1 = ki;
                    } else {
                        old_e2 = ki;
                    }
                    if v_new == BLACK {
                        new_b += 1;
                    } else if v_new == WHITE {
                        new_w += 1;
                    } else if new_e1 < 0 {
                        new_e1 = ki;
                    } else {
                        new_e2 = ki;
                    }
                }
                delta += window_contribution(new_b, new_w) - window_contribution(old_b, old_w);
                // 四威胁表增量：窗口恰好 4 子 + 1 空 → 空点是成五点
                if old_b == 4 && old_w == 0 {
                    five_dec(ctx, BLACK, old_e1 as usize);
                }
                if new_b == 4 && new_w == 0 {
                    five_inc(ctx, BLACK, new_e1 as usize);
                }
                if old_w == 4 && old_b == 0 {
                    five_dec(ctx, WHITE, old_e1 as usize);
                }
                if new_w == 4 && new_b == 0 {
                    five_inc(ctx, WHITE, new_e1 as usize);
                }
                // 成四点表增量：窗口恰好 3 子 + 2 空 → 两个空点都是成四点
                if old_b == 3 && old_w == 0 {
                    f3_dec(ctx, BLACK, old_e1 as usize);
                    if old_e2 >= 0 {
                        f3_dec(ctx, BLACK, old_e2 as usize);
                    }
                }
                if new_b == 3 && new_w == 0 {
                    f3_inc(ctx, BLACK, new_e1 as usize);
                    if new_e2 >= 0 {
                        f3_inc(ctx, BLACK, new_e2 as usize);
                    }
                }
                if old_w == 3 && old_b == 0 {
                    f3_dec(ctx, WHITE, old_e1 as usize);
                    if old_e2 >= 0 {
                        f3_dec(ctx, WHITE, old_e2 as usize);
                    }
                }
                if new_w == 3 && new_b == 0 {
                    f3_inc(ctx, WHITE, new_e1 as usize);
                    if new_e2 >= 0 {
                        f3_inc(ctx, WHITE, new_e2 as usize);
                    }
                }
            }
        }
        ctx.EVAL_SCORE += delta;
    }
}

fn five_inc(ctx: &mut ThreadState, color: u8, e: usize) {
    unsafe {
        if color == BLACK {
            ctx.FIVE_B[e] += 1;
            if ctx.FIVE_B[e] == 1 {
                ctx.FIVE_B_CELLS += 1;
                ctx.FIVE_B_MASK[e >> 6] |= 1u64 << (e & 63);
            }
        } else {
            ctx.FIVE_W[e] += 1;
            if ctx.FIVE_W[e] == 1 {
                ctx.FIVE_W_CELLS += 1;
                ctx.FIVE_W_MASK[e >> 6] |= 1u64 << (e & 63);
            }
        }
    }
}

fn five_dec(ctx: &mut ThreadState, color: u8, e: usize) {
    unsafe {
        if color == BLACK {
            ctx.FIVE_B[e] -= 1;
            if ctx.FIVE_B[e] == 0 {
                ctx.FIVE_B_CELLS -= 1;
                ctx.FIVE_B_MASK[e >> 6] &= !(1u64 << (e & 63));
            }
        } else {
            ctx.FIVE_W[e] -= 1;
            if ctx.FIVE_W[e] == 0 {
                ctx.FIVE_W_CELLS -= 1;
                ctx.FIVE_W_MASK[e >> 6] &= !(1u64 << (e & 63));
            }
        }
    }
}

fn f3_inc(ctx: &mut ThreadState, color: u8, e: usize) {
    unsafe {
        if color == BLACK {
            ctx.F3_B[e] += 1;
            if ctx.F3_B[e] == 1 {
                ctx.F3_B_CELLS += 1;
                ctx.F3_B_MASK[e >> 6] |= 1u64 << (e & 63);
            }
        } else {
            ctx.F3_W[e] += 1;
            if ctx.F3_W[e] == 1 {
                ctx.F3_W_CELLS += 1;
                ctx.F3_W_MASK[e >> 6] |= 1u64 << (e & 63);
            }
        }
    }
}

fn f3_dec(ctx: &mut ThreadState, color: u8, e: usize) {
    unsafe {
        if color == BLACK {
            ctx.F3_B[e] -= 1;
            if ctx.F3_B[e] == 0 {
                ctx.F3_B_CELLS -= 1;
                ctx.F3_B_MASK[e >> 6] &= !(1u64 << (e & 63));
            }
        } else {
            ctx.F3_W[e] -= 1;
            if ctx.F3_W[e] == 0 {
                ctx.F3_W_CELLS -= 1;
                ctx.F3_W_MASK[e >> 6] &= !(1u64 << (e & 63));
            }
        }
    }
}

/** 增量总分的行棋方视角值（正 = 当前行棋方优） */
fn eval_side(ctx: &mut ThreadState, color: u8) -> i32 {
    unsafe {
        if color == BLACK {
            ctx.EVAL_SCORE
        } else {
            -ctx.EVAL_SCORE
        }
    }
}

/** 掩码迭代：产出 mask 中所有成五点（cell index）。 */
struct FiveIter {
    mask: [u64; 4],
    w: usize,
    bits: u64,
}
impl FiveIter {
    fn new(ctx: &mut ThreadState, color: u8) -> FiveIter {
        unsafe {
            if color == BLACK {
                FiveIter { mask: ctx.FIVE_B_MASK, w: 0, bits: 0 }
            } else {
                FiveIter { mask: ctx.FIVE_W_MASK, w: 0, bits: 0 }
            }
        }
    }
    fn next_cell(&mut self) -> Option<usize> {
        while self.bits == 0 {
            if self.w >= 4 {
                return None;
            }
            // 载入当前字并立即推进：位消费只走 self.bits，不回读 mask
            self.bits = self.mask[self.w];
            self.w += 1;
        }
        let b = self.bits.trailing_zeros() as usize;
        self.bits &= self.bits - 1;
        Some((self.w - 1) * 64 + b)
    }
}

/** 从空表全量重建四威胁/成四点表（search_best_move 入口一次性调用） */
fn build_five_tables(ctx: &mut ThreadState, ) {
    unsafe {
        ctx.FIVE_B = [0; N];
        ctx.FIVE_W = [0; N];
        ctx.FIVE_B_MASK = [0; 4];
        ctx.FIVE_W_MASK = [0; 4];
        ctx.FIVE_B_CELLS = 0;
        ctx.FIVE_W_CELLS = 0;
        ctx.F3_B = [0; N];
        ctx.F3_W = [0; N];
        ctx.F3_B_MASK = [0; 4];
        ctx.F3_W_MASK = [0; 4];
        ctx.F3_B_CELLS = 0;
        ctx.F3_W_CELLS = 0;
        // 与 evaluate() 相同的四个窗口族
        for r in 0..SIZE {
            for c in 0..(SIZE - 4) {
                count_window_five(ctx, r, c, 0, 1);
            }
        }
        for r in 0..(SIZE - 4) {
            for c in 0..SIZE {
                count_window_five(ctx, r, c, 1, 0);
            }
        }
        for r in 0..(SIZE - 4) {
            for c in 0..(SIZE - 4) {
                count_window_five(ctx, r, c, 1, 1);
            }
        }
        for r in 0..(SIZE - 4) {
            for c in 4..SIZE {
                count_window_five(ctx, r, c, 1, -1);
            }
        }
    }
}

/// 统计起点 (r,c)、步长 (dy,dx) 的 5 连窗口：4+1 空记成五点，3+2 空记成四点
fn count_window_five(ctx: &mut ThreadState, r: i32, c: i32, dy: i32, dx: i32) {
    unsafe {
        let mut b = 0;
        let mut w = 0;
        let mut e1: i32 = -1;
        let mut e2: i32 = -1;
        for k in 0..5i32 {
            let v = ctx.BOARD[idx(r + dy * k, c + dx * k)];
            if v == BLACK {
                b += 1;
            } else if v == WHITE {
                w += 1;
            } else if e1 < 0 {
                e1 = idx(r + dy * k, c + dx * k) as i32;
            } else {
                e2 = idx(r + dy * k, c + dx * k) as i32;
            }
        }
        if b == 4 && w == 0 {
            five_inc(ctx, BLACK, e1 as usize);
        }
        if w == 4 && b == 0 {
            five_inc(ctx, WHITE, e1 as usize);
        }
        if b == 3 && w == 0 {
            f3_inc(ctx, BLACK, e1 as usize);
            if e2 >= 0 {
                f3_inc(ctx, BLACK, e2 as usize);
            }
        }
        if w == 3 && b == 0 {
            f3_inc(ctx, WHITE, e1 as usize);
            if e2 >= 0 {
                f3_inc(ctx, WHITE, e2 as usize);
            }
        }
    }
}

// ---------------------------------------------------------------- 候选生成/排序

/** 半径 2 邻域计数维护：落子后调用（放置 25 个 +1），撤子前调用配对的减量 */
fn near_delta(ctx: &mut ThreadState, r: i32, c: i32, d: i32) {
    unsafe {
        for dy in -2..=2 {
            for dx in -2..=2 {
                let rr = r + dy;
                let cc = c + dx;
                if in_bounds(rr, cc) {
                    let i = idx(rr, cc);
                    ctx.NEAR[i] = (ctx.NEAR[i] as i32 + d) as u16;
                }
            }
        }
    }
}

fn shape_score(board: &[u8], r: i32, c: i32, color: u8) -> i32 {
    let mut total = 0;
    for &(dx, dy) in DIRS.iter() {
        let mut cnt = 1;
        let mut open_ends = 0;
        let mut jump = 0;
        for sgn in [1, -1] {
            let mut step = 1;
            loop {
                let cc = c + dx * step * sgn;
                let rr = r + dy * step * sgn;
                if !in_bounds(rr, cc) {
                    break;
                }
                let st = board[idx(rr, cc)];
                if st == color {
                    cnt += 1;
                } else if st == 0 && jump == 0 {
                    let ncc = c + dx * (step + 1) * sgn;
                    let nrr = r + dy * (step + 1) * sgn;
                    if in_bounds(nrr, ncc) && board[idx(nrr, ncc)] == color {
                        jump += 1;
                        step += 1;
                        continue;
                    }
                    open_ends += 1;
                    break;
                } else {
                    break;
                }
                step += 1;
            }
        }
        if cnt >= 5 {
            total += 100000;
        } else if cnt == 4 {
            total += if open_ends > 0 { 5000 } else { 2000 };
        } else if cnt == 3 {
            total += if open_ends == 2 {
                800
            } else if open_ends == 1 {
                300
            } else {
                0
            };
        } else if cnt == 2 {
            total += if open_ends == 2 {
                60
            } else if open_ends == 1 {
                20
            } else {
                0
            };
        } else {
            total += if open_ends == 2 { 4 } else { 1 };
        }
    }
    total
}

fn quick_score(board: &[u8], r: i32, c: i32, color: u8) -> i32 {
    let opp = if color == BLACK { WHITE } else { BLACK };
    shape_score(board, r, c, color) + (3 * shape_score(board, r, c, opp)) / 4
}

fn ordered_candidates(ctx: &mut ThreadState, color: u8, width: usize, tt_move: u16, ply: usize) -> ([u16; N], usize) {
    let width = if width == 0 { 1 } else { width };
    let mut cands = [0u16; N];
    let mut scores = [0i32; N];
    let mut n = 0usize;
    unsafe {
        for r in 0..SIZE {
            for c in 0..SIZE {
                let i = idx(r, c);
                if ctx.BOARD[i] != 0 || ctx.NEAR[i] == 0 {
                    continue;
                }
                let ci = i as u16;
                let mut s = quick_score(&ctx.BOARD, r, c, color) * 16;
                if ci == tt_move {
                    s += 1 << 30;
                } else if ci == ctx.KILLERS[ply][0] {
                    s += 1 << 28;
                } else if ci == ctx.KILLERS[ply][1] {
                    s += 1 << 27;
                }
                s += ctx.HISTORY[i] >> 4;
                cands[n] = ci;
                scores[n] = s;
                n += 1;
            }
        }
    }
    // 部分选择排序：只维护降序 top-pool 前缀（O(n·pool)）。
    // [A/B 变体] pool=width：禁手过滤后黑方候选可能不足额，换取更高节点率
    let pool = width;
    let mut m = 0usize;
    for i in 0..n {
        let sc = scores[i];
        let cd = cands[i];
        if m == pool {
            if sc <= scores[pool - 1] {
                continue;
            }
            let mut j = pool - 1;
            while j > 0 && scores[j - 1] < sc {
                j -= 1;
            }
            let mut k = pool - 1;
            while k > j {
                scores[k] = scores[k - 1];
                cands[k] = cands[k - 1];
                k -= 1;
            }
            scores[j] = sc;
            cands[j] = cd;
        } else {
            let mut j = m;
            while j > 0 && scores[j - 1] < sc {
                j -= 1;
            }
            let mut k = m;
            while k > j {
                scores[k] = scores[k - 1];
                cands[k] = cands[k - 1];
                k -= 1;
            }
            scores[j] = sc;
            cands[j] = cd;
            m += 1;
        }
    }
    n = m;
    if color == BLACK {
        let mut m2 = 0usize;
        for i in 0..n {
            let ci = cands[i] as usize;
            let r = (ci / 15) as i32;
            let c = (ci % 15) as i32;
            unsafe {
                ctx.BOARD[ci] = BLACK;
                let forbidden = check_forbidden(&ctx.BOARD, r, c, 0);
                ctx.BOARD[ci] = 0;
                if forbidden {
                    continue;
                }
            }
            cands[m2] = cands[i];
            m2 += 1;
        }
        n = m2;
    }
    // 禁手过滤后统一截断到 width：保证黑方拿到满额合法着
    if n > width {
        n = width;
    }
    (cands, n)
}

// ---------------------------------------------------------------- 搜索

fn tt_probe(hash: u32, depth: i32, alpha: i32, beta: i32) -> (i32, u16) {
    let mut i = (hash as usize) & TT_MASK;
    for _ in 0..4 {
        if tt_try_lock(i) {
            let a = TT_A[i].load(Ordering::Relaxed);
            let key = a as u32;
            let mut result = (INF, 0);
            if key == hash {
                let c = TT_META[i].load(Ordering::Relaxed);
                if (c & 0xffffff) == ((hash as u64) & 0xffffff) {
                    let d = (((c >> 24) & 0xff) as i32) - 128;
                    if d >= depth {
                        let flag = ((c >> 32) & 0xff) as u8;
                        let score = (a >> 32) as u32 as i32;
                        let hit = match flag {
                            0 => true,
                            1 => score >= beta,
                            2 => score <= alpha,
                            _ => false,
                        };
                        if hit {
                            let best_move = ((c >> 48) & 0xffff) as u16;
                            result = (score, best_move);
                        }
                    }
                }
            }
            tt_unlock(i);
            if result.0 != INF {
                return result;
            }
        }
        i = (i + 1) & TT_MASK;
    }
    (INF, 0)
}

fn tt_store(hash: u32, depth: i32, flag: u8, score: i32, best_move: u16) {
    let i = (hash as usize) & TT_MASK;
    if !tt_try_lock(i) {
        return; // 槽位争用：丢弃本次 store（Lazy SMP 下无害）
    }
    let meta = ((hash as u64) & 0xffffff)
        | ((((depth + 128) as u64) & 0xff) << 24)
        | ((flag as u64) << 32)
        | ((best_move as u64) << 48);
    TT_META[i].store(meta, Ordering::Relaxed);
    let a = (hash as u64) | ((score as u32 as u64) << 32);
    TT_A[i].store(a, Ordering::Relaxed);
    tt_unlock(i);
}

fn negamax(ctx: &mut ThreadState, color: u8, depth: i32, alpha: i32, beta: i32, ply: i32) -> i32 {
    unsafe {
        ctx.NODES += 1;
        if ply > ctx.MAX_PLY {
            ctx.MAX_PLY = ply;
        }
        if ctx.NODES & 1023 == 0 && now() > ctx.DEADLINE {
            ctx.TIMED_OUT = true;
        }
        if ctx.TIMED_OUT {
            // 软超时：立即返回增量维护的静态分，不再递归更深
            let e = ctx.EVAL_SCORE;
            return if color == BLACK { e } else { -e };
        }
        // 强制线硬上限：威胁延伸不扣深度，用 ply 封顶保证递归与杀手表下标有界
        if ply >= 62 {
            let e = ctx.EVAL_SCORE;
            return if color == BLACK { e } else { -e };
        }
    }
    let opp = if color == BLACK { WHITE } else { BLACK };
    let hash = unsafe { ctx.HASH ^ COLOR_SALT[color as usize] };

    let (tt_score, tt_move) = tt_probe(hash, depth, alpha, beta);
    if tt_score != INF {
        return tt_score;
    }

    // ---- 威胁扫描（位掩码迭代：安静局面全零掩码 ~免费，战术局面只遍历真实成五点）----
    // 我有成五点 → 当即取胜；对方 ≥2 个成五点 → 必败（一步挡不完）；
    // 对方恰 1 个 → 唯一挡点强制应手，且不扣深度（威胁延伸：冲四连招可搜 20+ 层）
    unsafe {
        let (my_cells, opp_cells) = if color == BLACK {
            (ctx.FIVE_B_CELLS, ctx.FIVE_W_CELLS)
        } else {
            (ctx.FIVE_W_CELLS, ctx.FIVE_B_CELLS)
        };
        if my_cells > 0 {
            let mut it = FiveIter::new(ctx, color);
            while let Some(i) = it.next_cell() {
                if ctx.BOARD[i] != 0 {
                    continue;
                }
                // 黑方的成五点须恰好五连（长连不算胜，是假五）
                if color == WHITE || find_winning_line(&ctx.BOARD, (i / 15) as i32, (i % 15) as i32, BLACK, true) {
                    return MATE - ply;
                }
            }
        }
        if opp_cells > 0 {
            let mut it = FiveIter::new(ctx, opp);
            let (mut cnt, mut pt) = (0i32, 0usize);
            while let Some(i) = it.next_cell() {
                if ctx.BOARD[i] != 0 {
                    continue;
                }
                // 对方是黑时同样校验假五
                if color == WHITE && !find_winning_line(&ctx.BOARD, (i / 15) as i32, (i % 15) as i32, BLACK, true) {
                    continue;
                }
                cnt += 1;
                pt = i;
                if cnt >= 2 {
                    break;
                }
            }
            if cnt >= 2 {
                return -MATE + ply + 1;
            }
            if cnt == 1 {
                let r = (pt / 15) as i32;
                let c = (pt % 15) as i32;
                if color == BLACK {
                    ctx.BOARD[pt] = BLACK;
                    let forbidden = check_forbidden(&ctx.BOARD, r, c, 0);
                    ctx.BOARD[pt] = 0;
                    if forbidden {
                        // 唯一挡点对黑是禁手 → 黑无法合法防守 → 败
                        return -MATE + ply + 1;
                    }
                }
                ctx.BOARD[pt] = color;
                ctx.HASH ^= zobrist_at(pt, color);
                eval_delta(ctx, r, c, 0);
                near_delta(ctx, r, c, 1);
                let val = -negamax(ctx, opp, depth, -beta, -alpha, ply + 1);
                near_delta(ctx, r, c, -1);
                ctx.HASH ^= zobrist_at(pt, color);
                ctx.BOARD[pt] = 0;
                eval_delta(ctx, r, c, color);
                return val;
            }
        }
    }

    if depth <= 0 {
        // ---- VCF 静态延伸（quiescence）----
        // 叶节点上己方「成四手」（三→四）是强制手：对手必须挡五点，否则成五。
        // 只延伸成四手并让强制挡点机制接力，冲四连招（VCF）在叶节点精确解析，
        // 消除地平线截断误差。链值与静态评估取 max（stand-pat）。
        // depth 负数计_VCF_QMAX 为攻击手预算，防止攻击树无界爆炸。
        let my_f3_cells = unsafe { if color == BLACK { ctx.F3_B_CELLS } else { ctx.F3_W_CELLS } };
        if my_f3_cells == 0 || depth <= -VCF_QMAX {
            let e = unsafe { ctx.EVAL_SCORE };
            return if color == BLACK { e } else { -e };
        }
        let stand = eval_side(ctx, color);
        let mut best = stand;
        let mut a = alpha;
        let mut tried = 0usize;
        unsafe {
            let mask = if color == BLACK { ctx.F3_B_MASK } else { ctx.F3_W_MASK };
            let mut it = FiveIter { mask, w: 0, bits: 0 };
            while tried < 2 {
                let i = match it.next_cell() {
                    Some(i) => i,
                    None => break,
                };
                if ctx.BOARD[i] != 0 {
                    continue;
                }
                let r = (i / 15) as i32;
                let c = (i % 15) as i32;
                if color == BLACK {
                    ctx.BOARD[i] = BLACK;
                    let forbidden = check_forbidden(&ctx.BOARD, r, c, 0);
                    ctx.BOARD[i] = 0;
                    if forbidden {
                        continue;
                    }
                }
                tried += 1;
                ctx.BOARD[i] = color;
                ctx.HASH ^= zobrist_at(i, color);
                eval_delta(ctx, r, c, 0);
                near_delta(ctx, r, c, 1);
                let val = -negamax(ctx, opp, depth - 1, -beta, -a, ply + 1);
                near_delta(ctx, r, c, -1);
                ctx.HASH ^= zobrist_at(i, color);
                ctx.BOARD[i] = 0;
                eval_delta(ctx, r, c, color);
                if val > best {
                    best = val;
                }
                if val > a {
                    a = val;
                }
                if a >= beta {
                    break;
                }
            }
        }
        return best;
    }

    // 内部宽度 16：α-β 的有效分支约 √width，从 24 收窄到 16 节点数约降 5 倍；
    // 对打实测与 24 等胜率且节点率高 35%
    let (cands, n) = ordered_candidates(ctx, color, 16, tt_move, ply as usize);
    if n == 0 {
        return if color == BLACK { -MATE + ply } else { MATE - ply };
    }

    let mut best = -INF;
    let mut best_move = 0u16;
    let mut a = alpha;
    let mut first = true;
    for i in 0..n {
        let ci = cands[i] as usize;
        let r = (ci / 15) as i32;
        let c = (ci % 15) as i32;
        unsafe {
            ctx.BOARD[ci] = color;
            ctx.HASH ^= zobrist_at(ci, color);
            eval_delta(ctx, r, c, 0);
            near_delta(ctx, r, c, 1);
        }
        let mut val;
        if is_winning_stone(unsafe { &ctx.BOARD }, r, c, color) {
            val = MATE - ply;
        } else if first {
            val = -negamax(ctx, opp, depth - 1, -beta, -a, ply + 1);
            first = false;
        } else {
            // LMR（迟到着法降深）：安静节点（双方均无成五威胁）的靠后着法先用
            // depth-2 零窗口试探，fail-high 再全深重搜。战术区域（四表非零）不降；
            // 对打实测与不降深等胜率但深度更高（8 局 4:4，10s 深度 10 vs 8）。
            let quiet = unsafe { ctx.FIVE_B_CELLS == 0 && ctx.FIVE_W_CELLS == 0 };
            let reduction = if quiet && depth >= 3 && i >= 4 { 2 } else { 1 };
            val = -negamax(ctx, opp, depth - reduction, -(a + 1), -a, ply + 1);
            if val > a && val < beta {
                val = -negamax(ctx, opp, depth - 1, -beta, -a, ply + 1);
            }
        }
        unsafe {
            near_delta(ctx, r, c, -1);
            ctx.HASH ^= zobrist_at(ci, color);
            ctx.BOARD[ci] = 0;
            eval_delta(ctx, r, c, color);
        }
        if val > best {
            best = val;
            best_move = cands[i];
        }
        if val > a {
            a = val;
        }
        if a >= beta {
            unsafe {
                let k = &mut ctx.KILLERS[ply as usize];
                if k[0] != cands[i] {
                    k[1] = k[0];
                    k[0] = cands[i];
                }
                ctx.HISTORY[ci] += depth;
            }
            break;
        }
    }

    let flag = if best <= alpha {
        2
    } else if best >= beta {
        1
    } else {
        0
    };
    tt_store(hash, depth, flag, best, best_move);
    best
}

fn search_root(ctx: &mut ThreadState, color: u8, cands: &[u16], n: usize, depth: i32, alpha: i32, beta: i32) -> (u16, i32) {
    let opp = if color == BLACK { WHITE } else { BLACK };
    let mut a = alpha;
    let mut best_move = cands[0];
    let mut best_score = -INF;
    // 已知必败（分数在 -MATE 邻域）时：所有着法都会 fail-low，零窗口/PVS
    // 返回的是上界而非精确值，"输得最慢"的比较会被破坏 → 全窗口精确搜索。
    // 代价可接受：必败树在威胁延伸下节点很少（实测 3 万级）。
    let all_losing = alpha <= -(MATE - 200);
    for j in 0..n {
        let ci = cands[j] as usize;
        let r = (ci / 15) as i32;
        let c = (ci % 15) as i32;
        unsafe {
            ctx.BOARD[ci] = color;
            ctx.HASH ^= zobrist_at(ci, color);
            eval_delta(ctx, r, c, 0);
            near_delta(ctx, r, c, 1);
        }
        let mut val;
        if is_winning_stone(unsafe { &ctx.BOARD }, r, c, color) {
            val = MATE;
        } else if j == 0 || all_losing {
            val = -negamax(ctx, opp, depth - 1, -beta, -a, 1);
        } else {
            val = -negamax(ctx, opp, depth - 1, -(a + 1), -a, 1);
            if val > a && val < beta {
                val = -negamax(ctx, opp, depth - 1, -beta, -a, 1);
            }
        }
        unsafe {
            near_delta(ctx, r, c, -1);
            ctx.HASH ^= zobrist_at(ci, color);
            ctx.BOARD[ci] = 0;
            eval_delta(ctx, r, c, color);
        }
        if val > best_score {
            best_score = val;
            best_move = cands[j];
        }
        if val > a {
            a = val;
        }
    }
    (best_move, best_score)
}

#[no_mangle]
pub extern "C" fn search_best_move(color: u32, max_depth: u32, time_ms: u32, width: u32) -> i32 {
    let ctx = ts();
    let col = color as u8;
    unsafe {
        ctx.NODES = 0;
        ctx.TIMED_OUT = false;
        ctx.MAX_PLY = 0;
        ctx.DEADLINE = now() + time_ms as f64;
        ctx.HASH = 0;
        for i in 0..N {
            ctx.HISTORY[i] = 0;
            ctx.NEAR[i] = 0;
            if ctx.BOARD[i] != 0 {
                ctx.HASH ^= zobrist_at(i, ctx.BOARD[i]);
                let r = (i / 15) as i32;
                let c = (i % 15) as i32;
                near_delta(ctx, r, c, 1);
            }
        }
        ctx.EVAL_SCORE = evaluate(&ctx.BOARD);
        build_five_tables(ctx, );
        tt_clear();
        for i in 0..64 {
            ctx.KILLERS[i] = [0, 0];
        }
    }

    let (cands, n) = ordered_candidates(ctx, col, width as usize, 0, 0);

    for i in 0..n {
        let ci = cands[i] as usize;
        let r = (ci / 15) as i32;
        let c = (ci % 15) as i32;
        unsafe {
            ctx.BOARD[ci] = col;
            let win = is_winning_stone(&ctx.BOARD, r, c, col);
            ctx.BOARD[ci] = 0;
            if win {
                ctx.RESULT_SCORE = MATE;
                ctx.RESULT_DEPTH = 1;
                ctx.RESULT_NODES = ctx.NODES as i32;
                ctx.RESULT_TIMED_OUT = 0;
                return ci as i32;
            }
        }
    }

    if n == 0 {
        unsafe {
            ctx.RESULT_SCORE = -MATE;
            ctx.RESULT_DEPTH = 0;
            ctx.RESULT_NODES = 0;
            ctx.RESULT_TIMED_OUT = 0;
        }
        return -1;
    }

    let mut best_move = cands[0];
    let mut best_score = -INF;
    let mut reached_depth = 0;

    let mut depth = 2i32;
    while depth <= max_depth as i32 {
        unsafe {
            if ctx.TIMED_OUT {
                break;
            }
        }
        let mut alpha = -MATE;
        let mut beta = MATE;
        if depth > 2 && best_score > -MATE / 2 && best_score < MATE / 2 {
            alpha = best_score - 200;
            beta = best_score + 200;
        }
        // 已知必败：aspiration 窗口只会触发 fail-low 重搜，直接全窗口
        if best_score <= -(MATE - 200) {
            alpha = -MATE;
        }
        let (m, s) = search_root(ctx, col, &cands, n, depth, alpha, beta);
        if s <= alpha || s >= beta {
            let (m2, s2) = search_root(ctx, col, &cands, n, depth, -MATE, MATE);
            unsafe {
                if !ctx.TIMED_OUT {
                    best_move = m2;
                    best_score = s2;
                    reached_depth = depth;
                }
            }
        } else {
            unsafe {
                if !ctx.TIMED_OUT {
                    best_move = m;
                    best_score = s;
                    reached_depth = depth;
                }
            }
        }
        // 步长 2：实测同预算下比步长 1 多完成一层（中间迭代的开销不划算）
        depth += 2;
        // 必胜/必败已证明（MATE 级分值）：继续加深只会找更短的杀法，直接停，
        // 避免找到活四后仍烧满全部时间
        if best_score >= MATE - 200 || best_score <= -(MATE - 200) {
            break;
        }
    }

    unsafe {
        ctx.RESULT_SCORE = best_score;
        ctx.RESULT_DEPTH = reached_depth;
        ctx.RESULT_NODES = ctx.NODES as i32;
        ctx.RESULT_TIMED_OUT = if ctx.TIMED_OUT { 1 } else { 0 };
    }
    best_move as i32
}

/// 根子集搜索（root splitting 并行入口）：
/// 与 search_best_move 相同的初始化与迭代加深，但根节点只搜 mask 指定的候选
/// （cands 的下标位掩码，bit j = 搜 cands[j]）。供 JS 侧多 Worker 各搜根子集后
/// 汇总——各实例独立 TT，无锁竞争。mask=0 时退化为全候选（等价 search_best_move）。
#[no_mangle]
pub extern "C" fn search_best_move_subset(
    color: u32,
    max_depth: u32,
    time_ms: u32,
    width: u32,
    mask: u64,
) -> i32 {
    let ctx = ts();
    let col = color as u8;
    unsafe {
        ctx.NODES = 0;
        ctx.TIMED_OUT = false;
        ctx.MAX_PLY = 0;
        ctx.DEADLINE = now() + time_ms as f64;
        ctx.HASH = 0;
        for i in 0..N {
            ctx.HISTORY[i] = 0;
            ctx.NEAR[i] = 0;
            if ctx.BOARD[i] != 0 {
                ctx.HASH ^= zobrist_at(i, ctx.BOARD[i]);
                let r = (i / 15) as i32;
                let c = (i % 15) as i32;
                near_delta(ctx, r, c, 1);
            }
        }
        ctx.EVAL_SCORE = evaluate(&ctx.BOARD);
        build_five_tables(ctx, );
        tt_clear();
        for i in 0..64 {
            ctx.KILLERS[i] = [0, 0];
        }
    }

    let (cands, n) = ordered_candidates(ctx, col, width as usize, 0, 0);

    // 即胜检测（与主入口一致）：子集内的制胜点直接返回
    for i in 0..n {
        if mask != 0 && (mask >> i) & 1 == 0 {
            continue;
        }
        let ci = cands[i] as usize;
        let r = (ci / 15) as i32;
        let c = (ci % 15) as i32;
        unsafe {
            ctx.BOARD[ci] = col;
            let win = is_winning_stone(&ctx.BOARD, r, c, col);
            ctx.BOARD[ci] = 0;
            if win {
                ctx.RESULT_SCORE = MATE;
                ctx.RESULT_DEPTH = 1;
                ctx.RESULT_NODES = ctx.NODES as i32;
                ctx.RESULT_TIMED_OUT = 0;
                return ci as i32;
            }
        }
    }

    // 子集打包成连续数组（search_root 需要连续切片）；mask=0 视为全候选
    let mut subset = [0u16; 64];
    let mut sn = 0usize;
    for i in 0..n {
        if (mask == 0 || (mask >> i) & 1 == 1) && sn < 64 {
            subset[sn] = cands[i];
            sn += 1;
        }
    }
    if sn == 0 {
        unsafe {
            ctx.RESULT_SCORE = -MATE;
            ctx.RESULT_DEPTH = 0;
            ctx.RESULT_NODES = 0;
            ctx.RESULT_TIMED_OUT = 0;
        }
        return -1;
    }

    let mut best_move = subset[0];
    let mut best_score = -INF;
    let mut reached_depth = 0;

    let mut depth = 2i32;
    while depth <= max_depth as i32 {
        unsafe {
            if ctx.TIMED_OUT {
                break;
            }
        }
        let mut alpha = -MATE;
        let mut beta = MATE;
        if depth > 2 && best_score > -MATE / 2 && best_score < MATE / 2 {
            alpha = best_score - 200;
            beta = best_score + 200;
        }
        if best_score <= -(MATE - 200) {
            alpha = -MATE;
        }
        let (m, s) = search_root(ctx, col, &subset, sn, depth, alpha, beta);
        if s <= alpha || s >= beta {
            let (m2, s2) = search_root(ctx, col, &subset, sn, depth, -MATE, MATE);
            unsafe {
                if !ctx.TIMED_OUT {
                    best_move = m2;
                    best_score = s2;
                    reached_depth = depth;
                }
            }
        } else {
            unsafe {
                if !ctx.TIMED_OUT {
                    best_move = m;
                    best_score = s;
                    reached_depth = depth;
                }
            }
        }
        depth += 2;
        if best_score >= MATE - 200 || best_score <= -(MATE - 200) {
            break;
        }
    }

    unsafe {
        ctx.RESULT_SCORE = best_score;
        ctx.RESULT_DEPTH = reached_depth;
        ctx.RESULT_NODES = ctx.NODES as i32;
        ctx.RESULT_TIMED_OUT = if ctx.TIMED_OUT { 1 } else { 0 };
    }
    best_move as i32
}

/// 根=显式着法坐标列表的搜索（root splitting 第二阶段——重验证汇总）：
/// moves 为 y*15+x 编码的着法数组（由 JS 写入 moves_buffer），n 为数量。
/// 与 search_best_move 同构，但根候选固定为给定列表（按给定顺序）。
/// 用于并行搜索后对少数候选着法做统一全窗口精搜，消除各子集分数不可比的问题。
#[no_mangle]
pub extern "C" fn moves_buffer() -> *mut u16 {
    let ctx = ts();
    unsafe { ctx.MOVES_BUF.as_mut_ptr() }
}

#[no_mangle]
pub extern "C" fn search_moves(color: u32, max_depth: u32, time_ms: u32, n_moves: u32) -> i32 {
    let ctx = ts();
    let col = color as u8;
    unsafe {
        ctx.NODES = 0;
        ctx.TIMED_OUT = false;
        ctx.MAX_PLY = 0;
        ctx.DEADLINE = now() + time_ms as f64;
        ctx.HASH = 0;
        for i in 0..N {
            ctx.HISTORY[i] = 0;
            ctx.NEAR[i] = 0;
            if ctx.BOARD[i] != 0 {
                ctx.HASH ^= zobrist_at(i, ctx.BOARD[i]);
                let r = (i / 15) as i32;
                let c = (i % 15) as i32;
                near_delta(ctx, r, c, 1);
            }
        }
        ctx.EVAL_SCORE = evaluate(&ctx.BOARD);
        build_five_tables(ctx, );
        tt_clear();
        for i in 0..64 {
            ctx.KILLERS[i] = [0, 0];
        }
    }

    let n = (n_moves as usize).min(64);
    if n == 0 {
        unsafe {
            ctx.RESULT_SCORE = -MATE;
            ctx.RESULT_DEPTH = 0;
            ctx.RESULT_NODES = 0;
            ctx.RESULT_TIMED_OUT = 0;
        }
        return -1;
    }

    let mut subset = [0u16; 64];
    unsafe {
        for i in 0..n {
            subset[i] = ctx.MOVES_BUF[i];
        }
    }

    // 即胜检测
    for i in 0..n {
        let ci = subset[i] as usize;
        let r = (ci / 15) as i32;
        let c = (ci % 15) as i32;
        unsafe {
            ctx.BOARD[ci] = col;
            let win = is_winning_stone(&ctx.BOARD, r, c, col);
            ctx.BOARD[ci] = 0;
            if win {
                ctx.RESULT_SCORE = MATE;
                ctx.RESULT_DEPTH = 1;
                ctx.RESULT_NODES = ctx.NODES as i32;
                ctx.RESULT_TIMED_OUT = 0;
                return ci as i32;
            }
        }
    }

    let mut best_move = subset[0];
    let mut best_score = -INF;
    let mut reached_depth = 0;

    let mut depth = 2i32;
    while depth <= max_depth as i32 {
        unsafe {
            if ctx.TIMED_OUT {
                break;
            }
        }
        let mut alpha = -MATE;
        let mut beta = MATE;
        if depth > 2 && best_score > -MATE / 2 && best_score < MATE / 2 {
            alpha = best_score - 200;
            beta = best_score + 200;
        }
        if best_score <= -(MATE - 200) {
            alpha = -MATE;
        }
        let (m, s) = search_root(ctx, col, &subset, n, depth, alpha, beta);
        if s <= alpha || s >= beta {
            let (m2, s2) = search_root(ctx, col, &subset, n, depth, -MATE, MATE);
            unsafe {
                if !ctx.TIMED_OUT {
                    best_move = m2;
                    best_score = s2;
                    reached_depth = depth;
                }
            }
        } else {
            unsafe {
                if !ctx.TIMED_OUT {
                    best_move = m;
                    best_score = s;
                    reached_depth = depth;
                }
            }
        }
        depth += 2;
        if best_score >= MATE - 200 || best_score <= -(MATE - 200) {
            break;
        }
    }

    unsafe {
        ctx.RESULT_SCORE = best_score;
        ctx.RESULT_DEPTH = reached_depth;
        ctx.RESULT_NODES = ctx.NODES as i32;
        ctx.RESULT_TIMED_OUT = if ctx.TIMED_OUT { 1 } else { 0 };
    }
    best_move as i32
}

// ---------------------------------------------------------------- Lazy SMP 入口

/** 每实例全局：线程编号/总数/共享区基址与步长（mutable global → 每实例独立） */
static mut MY_TID: u32 = 0;
static mut MY_THREADS: u32 = 1;
static mut MY_HEAP_BASE: u32 = 0;
static mut MY_STRIDE: u32 = 0;
/** 每线程栈区大小（字节）。JS 布局：state_t = heap + tid*stride；栈区 [state_t+state_size, +STACK)，__stack_pointer 置于栈区顶。 */
const SMP_STACK_SIZE: u32 = 1024 * 1024;

#[no_mangle]
pub extern "C" fn smp_state_size() -> u32 {
    core::mem::size_of::<ThreadState>() as u32
}

#[no_mangle]
pub extern "C" fn smp_stack_size() -> u32 {
    SMP_STACK_SIZE
}

/// 每实例初始化：把本实例的线程状态区指到共享内存的专属分区。
/// JS 侧须先设置 __stack_pointer（布局：heap + tid*stride + state_size + STACK），再调用本函数。
#[no_mangle]
pub extern "C" fn smp_init(tid: u32, threads: u32, heap_base: u32, stride: u32) {
    unsafe {
        // MY_* 位于共享内存：THREADS/HEAP/STRIDE 各线程写入同值无竞态；
        // THREAD_BASE 只允许 tid=0（主线程/单线程路径）写入——helper 的状态区
        // 由 smp_helper_run 的 tid 参数自行推导，避免共享覆盖。
        MY_TID = tid;
        MY_THREADS = threads;
        MY_HEAP_BASE = heap_base;
        MY_STRIDE = stride;
        if tid == 0 {
            THREAD_BASE = heap_base;
        }
    }
}

/// 主线程把 BOARD 广播到其他线程状态区（helpers 各自的 search_impl 前置会自行重算增量表）
#[no_mangle]
pub extern "C" fn smp_broadcast_board() {
    unsafe {
        let threads = MY_THREADS;
        let heap = MY_HEAP_BASE;
        let stride = MY_STRIDE;
        let src = ts().BOARD;
        for t in 1..threads {
            let dst = (heap + t * stride) as *mut ThreadState;
            (*dst).BOARD = src;
        }
    }
}

/// 主线程 SMP 搜索入口：广播局面 → 唤醒 helpers → 自身搜索 → 通知停止。
/// 返回值/RESULT_* 与 search_best_move 同口径（主线程自己的状态）。
#[no_mangle]
pub extern "C" fn search_best_move_smp(color: u32, max_depth: u32, time_ms: u32, width: u32) -> i32 {
    SMP_PARAMS[0].store(color, Ordering::Relaxed);
    SMP_PARAMS[1].store(max_depth, Ordering::Relaxed);
    SMP_PARAMS[2].store(time_ms, Ordering::Relaxed);
    SMP_PARAMS[3].store(width, Ordering::Relaxed);
    smp_broadcast_board();
    SMP_STOP.store(false, Ordering::Release);
    SMP_GO.store(true, Ordering::Release);
    SMP_KEEP_TT.store(true, Ordering::Relaxed);
    let r = search_best_move(color, max_depth, time_ms, width);
    SMP_KEEP_TT.store(false, Ordering::Relaxed);
    SMP_GO.store(false, Ordering::Release);
    SMP_STOP.store(true, Ordering::Release);
    r
}

/// helper 入口：自旋等待主线程唤醒（GO），按共享参数搜索（不清 TT），主线程 STOP 后自行中止。
/// 返回本线程节点数（统计用）。搜索结果不导出——helper 的价值全部沉淀在共享 TT 里。
#[no_mangle]
pub extern "C" fn smp_helper_run(tid: u32) -> u32 {
    // tid 参数显式传入（MY_TID 在共享内存不可靠）；状态区 = heap + tid*stride
    let ctx: &mut ThreadState =
        unsafe { &mut *((MY_HEAP_BASE + tid * MY_STRIDE) as *mut ThreadState) };
    while !SMP_GO.load(Ordering::Acquire) {
        // 自旋等待唤醒（等待窗口 = 主线程清 TT/广播的时间，毫秒级）
    }
    let color = SMP_PARAMS[0].load(Ordering::Acquire);
    let max_depth = SMP_PARAMS[1].load(Ordering::Acquire);
    let time_ms = SMP_PARAMS[2].load(Ordering::Acquire);
    let width = SMP_PARAMS[3].load(Ordering::Acquire);
    // 自身搜索（不广播、不清 TT；候选按 tid 轮转以错开搜索树）
    unsafe {
        ctx.NODES = 0;
        ctx.TIMED_OUT = false;
        ctx.MAX_PLY = 0;
        ctx.DEADLINE = now() + time_ms as f64;
        ctx.HASH = 0;
        for i in 0..N {
            ctx.HISTORY[i] = 0;
            ctx.NEAR[i] = 0;
            if ctx.BOARD[i] != 0 {
                ctx.HASH ^= zobrist_at(i, ctx.BOARD[i]);
                let r = (i / 15) as i32;
                let c = (i % 15) as i32;
                near_delta(ctx, r, c, 1);
            }
        }
        ctx.EVAL_SCORE = evaluate(&ctx.BOARD);
        build_five_tables(ctx, );
        for i in 0..64 {
            ctx.KILLERS[i] = [0, 0];
        }
    }
    let col = color as u8;
    let mut best_score = -INF;
    let mut depth = 2i32;
    while depth <= max_depth as i32 {
        unsafe {
            if ctx.TIMED_OUT || SMP_STOP.load(Ordering::Relaxed) {
                break;
            }
        }
        let mut alpha = -MATE;
        let mut beta = MATE;
        if depth > 2 && best_score > -MATE / 2 && best_score < MATE / 2 {
            alpha = best_score - 200;
            beta = best_score + 200;
        }
        if best_score <= -(MATE - 200) {
            alpha = -MATE;
        }
        let (mut c, n2) = ordered_candidates(ctx, col, width as usize, 0, 0);
        if n2 == 0 {
            break;
        }
        // tid 轮转根候选序：错开各 helper 的搜索树（主线程 tid=0 不轮转）
        let rot = (tid as usize) % n2;
        if rot > 0 {
            c.rotate_left(rot);
        }
        let (_m, s) = search_root(ctx, col, &c, n2, depth, alpha, beta);
        unsafe {
            if !ctx.TIMED_OUT {
                best_score = s;
            }
        }
        depth += 2;
        if best_score >= MATE - 200 || best_score <= -(MATE - 200) {
            break;
        }
    }
    unsafe { ctx.NODES }
}
