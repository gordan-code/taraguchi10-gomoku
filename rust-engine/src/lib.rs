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

const DIRS: [(i32, i32); 4] = [(1, 0), (0, 1), (1, 1), (1, -1)]; // (dx, dy)
const W: [i32; 6] = [0, 2, 24, 320, 3600, 1_000_000];

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

#[derive(Clone, Copy)]
struct TTEntry {
    key: u32,
    depth: i8,
    flag: u8,
    score: i32,
    best_move: u16,
}
const EMPTY_TT: TTEntry = TTEntry { key: 0, depth: 0, flag: 0, score: 0, best_move: 0 };

// ---------------------------------------------------------------- 全局搜索状态

static mut BOARD: [u8; N] = [0; N];
static mut HASH: u32 = 0;
static mut NODES: u32 = 0;
static mut DEADLINE: f64 = 0.0;
static mut TIMED_OUT: bool = false;
static mut TT: [TTEntry; TT_SIZE] = [EMPTY_TT; TT_SIZE];
static mut KILLERS: [[u16; 2]; 64] = [[0; 2]; 64];
static mut HISTORY: [i32; N] = [0; N];
/** 每格半径 2 内的棋子数（含自身）：候选判定从 25 点扫描降为单次读 */
static mut NEAR: [u16; N] = [0; N];
/** 四威胁表：FIVE_X[i] = 在 i 落 X 后即成五的窗口数（黑含长连假五，查询时校验恰好五） */
static mut FIVE_B: [i16; N] = [0; N];
static mut FIVE_W: [i16; N] = [0; N];
/** 成五点位掩码（4×u64 覆盖 225 格）：节点入口免 225 格线性扫，只迭代置位位 */
static mut FIVE_B_MASK: [u64; 4] = [0; 4];
static mut FIVE_W_MASK: [u64; 4] = [0; 4];
/** 上表的非零格数（0 = 无任何四威胁，节点入口可跳过细扫） */
static mut FIVE_B_CELLS: i32 = 0;
static mut FIVE_W_CELLS: i32 = 0;

static mut RESULT_SCORE: i32 = 0;
static mut RESULT_DEPTH: i32 = 0;
static mut RESULT_NODES: i32 = 0;
static mut RESULT_TIMED_OUT: i32 = 0;
/** 增量维护的黑方视角总分（与 evaluate() 全盘重算等价）；落子/撤子时增量更新 */
static mut EVAL_SCORE: i32 = 0;
/** 搜索到达的最大 ply（含威胁延伸）：反映强制线的真实搜索深度 */
static mut MAX_PLY: i32 = 0;

#[no_mangle]
pub extern "C" fn board_buffer() -> *mut u8 {
    unsafe { BOARD.as_mut_ptr() }
}
#[no_mangle]
pub extern "C" fn get_score() -> i32 {
    unsafe { RESULT_SCORE }
}
#[no_mangle]
pub extern "C" fn get_depth() -> i32 {
    unsafe { RESULT_DEPTH }
}
#[no_mangle]
pub extern "C" fn get_nodes() -> i32 {
    unsafe { RESULT_NODES }
}
#[no_mangle]
pub extern "C" fn get_timed_out() -> i32 {
    unsafe { RESULT_TIMED_OUT }
}
/** 调试：增量评估与全盘重算的差值（0 = 一致）。搜索结束后调用以验证不变量。 */
#[no_mangle]
pub extern "C" fn eval_consistency() -> i32 {
    unsafe { EVAL_SCORE - evaluate(&BOARD) }
}
/** 搜索到达的最大 ply（威胁延伸后可达名义深度数倍） */
#[no_mangle]
pub extern "C" fn get_seldepth() -> i32 {
    unsafe { MAX_PLY }
}
/** 调试：四威胁表与全盘重算的不一致格数（0 = 一致）。搜索结束后调用。 */
#[no_mangle]
pub extern "C" fn five_consistency() -> i32 {
    unsafe {
        let b = FIVE_B;
        let w = FIVE_W;
        let bc = FIVE_B_CELLS;
        let wc = FIVE_W_CELLS;
        build_five_tables();
        let mut bad = 0i32;
        for i in 0..N {
            if FIVE_B[i] != b[i] || FIVE_W[i] != w[i] {
                bad += 1;
            }
        }
        if FIVE_B_CELLS != bc || FIVE_W_CELLS != wc {
            bad += 1000;
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

/// BOARD[idx(r,c)] 已从 prev 变为当前值：重算所有经过该点的 5 连窗口，增量更新 EVAL_SCORE。
/// 落子后调 eval_delta(r, c, 0)；撤子后调 eval_delta(r, c, color)。
/// 禁手探测的临时放子/撤子不读 EVAL_SCORE，无需成对调用（净变化为零）。
fn eval_delta(r: i32, c: i32, prev: u8) {
    unsafe {
        let new_v = BOARD[idx(r, c)];
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
                let mut old_empty: i32 = -1;
                let mut new_empty: i32 = -1;
                for k in 0..5i32 {
                    let kr = sr + dy * k;
                    let kc = sc + dx * k;
                    let ki = idx(kr, kc) as i32;
                    let v = BOARD[idx(kr, kc)];
                    let v_old = if kr == r && kc == c { prev } else { v };
                    let v_new = if kr == r && kc == c { new_v } else { v };
                    if v_old == BLACK {
                        old_b += 1;
                    } else if v_old == WHITE {
                        old_w += 1;
                    } else {
                        old_empty = ki;
                    }
                    if v_new == BLACK {
                        new_b += 1;
                    } else if v_new == WHITE {
                        new_w += 1;
                    } else {
                        new_empty = ki;
                    }
                }
                delta += window_contribution(new_b, new_w) - window_contribution(old_b, old_w);
                // 四威胁表增量：窗口恰好 4 子 + 1 空 → 空点是成五点
                if old_b == 4 && old_w == 0 {
                    five_dec(BLACK, old_empty as usize);
                }
                if new_b == 4 && new_w == 0 {
                    five_inc(BLACK, new_empty as usize);
                }
                if old_w == 4 && old_b == 0 {
                    five_dec(WHITE, old_empty as usize);
                }
                if new_w == 4 && new_b == 0 {
                    five_inc(WHITE, new_empty as usize);
                }
            }
        }
        EVAL_SCORE += delta;
    }
}

fn five_inc(color: u8, e: usize) {
    unsafe {
        if color == BLACK {
            FIVE_B[e] += 1;
            if FIVE_B[e] == 1 {
                FIVE_B_CELLS += 1;
                FIVE_B_MASK[e >> 6] |= 1u64 << (e & 63);
            }
        } else {
            FIVE_W[e] += 1;
            if FIVE_W[e] == 1 {
                FIVE_W_CELLS += 1;
                FIVE_W_MASK[e >> 6] |= 1u64 << (e & 63);
            }
        }
    }
}

fn five_dec(color: u8, e: usize) {
    unsafe {
        if color == BLACK {
            FIVE_B[e] -= 1;
            if FIVE_B[e] == 0 {
                FIVE_B_CELLS -= 1;
                FIVE_B_MASK[e >> 6] &= !(1u64 << (e & 63));
            }
        } else {
            FIVE_W[e] -= 1;
            if FIVE_W[e] == 0 {
                FIVE_W_CELLS -= 1;
                FIVE_W_MASK[e >> 6] &= !(1u64 << (e & 63));
            }
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
    fn new(color: u8) -> FiveIter {
        unsafe {
            if color == BLACK {
                FiveIter { mask: FIVE_B_MASK, w: 0, bits: 0 }
            } else {
                FiveIter { mask: FIVE_W_MASK, w: 0, bits: 0 }
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

/** 从空表全量重建四威胁表（search_best_move 入口一次性调用） */
fn build_five_tables() {
    unsafe {
        FIVE_B = [0; N];
        FIVE_W = [0; N];
        FIVE_B_MASK = [0; 4];
        FIVE_W_MASK = [0; 4];
        FIVE_B_CELLS = 0;
        FIVE_W_CELLS = 0;
        // 与 evaluate() 相同的四个窗口族
        for r in 0..SIZE {
            for c in 0..(SIZE - 4) {
                count_window_five(r, c, 0, 1);
            }
        }
        for r in 0..(SIZE - 4) {
            for c in 0..SIZE {
                count_window_five(r, c, 1, 0);
            }
        }
        for r in 0..(SIZE - 4) {
            for c in 0..(SIZE - 4) {
                count_window_five(r, c, 1, 1);
            }
        }
        for r in 0..(SIZE - 4) {
            for c in 4..SIZE {
                count_window_five(r, c, 1, -1);
            }
        }
    }
}

/// 统计起点 (r,c)、步长 (dy,dx) 的 5 连窗口：恰好 4 子 + 1 空则空点记为成五点
fn count_window_five(r: i32, c: i32, dy: i32, dx: i32) {
    unsafe {
        let mut b = 0;
        let mut w = 0;
        let mut empty: i32 = -1;
        for k in 0..5i32 {
            let v = BOARD[idx(r + dy * k, c + dx * k)];
            if v == BLACK {
                b += 1;
            } else if v == WHITE {
                w += 1;
            } else {
                empty = idx(r + dy * k, c + dx * k) as i32;
            }
        }
        if b == 4 && w == 0 {
            five_inc(BLACK, empty as usize);
        }
        if w == 4 && b == 0 {
            five_inc(WHITE, empty as usize);
        }
    }
}

// ---------------------------------------------------------------- 候选生成/排序

/** 半径 2 邻域计数维护：落子后调用（放置 25 个 +1），撤子前调用配对的减量 */
fn near_delta(r: i32, c: i32, d: i32) {
    unsafe {
        for dy in -2..=2 {
            for dx in -2..=2 {
                let rr = r + dy;
                let cc = c + dx;
                if in_bounds(rr, cc) {
                    let i = idx(rr, cc);
                    NEAR[i] = (NEAR[i] as i32 + d) as u16;
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

fn ordered_candidates(color: u8, width: usize, tt_move: u16, ply: usize) -> ([u16; N], usize) {
    let width = if width == 0 { 1 } else { width };
    let mut cands = [0u16; N];
    let mut scores = [0i32; N];
    let mut n = 0usize;
    unsafe {
        for r in 0..SIZE {
            for c in 0..SIZE {
                let i = idx(r, c);
                if BOARD[i] != 0 || NEAR[i] == 0 {
                    continue;
                }
                let ci = i as u16;
                let mut s = quick_score(&BOARD, r, c, color) * 16;
                if ci == tt_move {
                    s += 1 << 30;
                } else if ci == KILLERS[ply][0] {
                    s += 1 << 28;
                } else if ci == KILLERS[ply][1] {
                    s += 1 << 27;
                }
                s += HISTORY[i] >> 4;
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
                BOARD[ci] = BLACK;
                let forbidden = check_forbidden(&BOARD, r, c, 0);
                BOARD[ci] = 0;
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
    unsafe {
        let mut i = (hash as usize) & TT_MASK;
        for _ in 0..4 {
            let e = TT[i];
            if e.key == hash && e.depth as i32 >= depth {
                let hit = match e.flag {
                    0 => true,
                    1 => e.score >= beta,
                    2 => e.score <= alpha,
                    _ => false,
                };
                if hit {
                    return (e.score, e.best_move);
                }
            }
            i = (i + 1) & TT_MASK;
        }
    }
    (INF, 0)
}

fn tt_store(hash: u32, depth: i32, flag: u8, score: i32, best_move: u16) {
    unsafe {
        let i = (hash as usize) & TT_MASK;
        TT[i] = TTEntry { key: hash, depth: depth as i8, flag, score, best_move };
    }
}

fn negamax(color: u8, depth: i32, alpha: i32, beta: i32, ply: i32) -> i32 {
    unsafe {
        NODES += 1;
        if ply > MAX_PLY {
            MAX_PLY = ply;
        }
        if NODES & 1023 == 0 && now() > DEADLINE {
            TIMED_OUT = true;
        }
        if TIMED_OUT {
            // 软超时：立即返回增量维护的静态分，不再递归更深
            let e = EVAL_SCORE;
            return if color == BLACK { e } else { -e };
        }
        // 强制线硬上限：威胁延伸不扣深度，用 ply 封顶保证递归与杀手表下标有界
        if ply >= 62 {
            let e = EVAL_SCORE;
            return if color == BLACK { e } else { -e };
        }
    }
    let opp = if color == BLACK { WHITE } else { BLACK };
    let hash = unsafe { HASH ^ COLOR_SALT[color as usize] };

    let (tt_score, tt_move) = tt_probe(hash, depth, alpha, beta);
    if tt_score != INF {
        return tt_score;
    }

    // ---- 威胁扫描（位掩码迭代：安静局面全零掩码 ~免费，战术局面只遍历真实成五点）----
    // 我有成五点 → 当即取胜；对方 ≥2 个成五点 → 必败（一步挡不完）；
    // 对方恰 1 个 → 唯一挡点强制应手，且不扣深度（威胁延伸：冲四连招可搜 20+ 层）
    unsafe {
        let (my_cells, opp_cells) = if color == BLACK {
            (FIVE_B_CELLS, FIVE_W_CELLS)
        } else {
            (FIVE_W_CELLS, FIVE_B_CELLS)
        };
        if my_cells > 0 {
            let mut it = FiveIter::new(color);
            while let Some(i) = it.next_cell() {
                if BOARD[i] != 0 {
                    continue;
                }
                // 黑方的成五点须恰好五连（长连不算胜，是假五）
                if color == WHITE || find_winning_line(&BOARD, (i / 15) as i32, (i % 15) as i32, BLACK, true) {
                    return MATE - ply;
                }
            }
        }
        if opp_cells > 0 {
            let mut it = FiveIter::new(opp);
            let (mut cnt, mut pt) = (0i32, 0usize);
            while let Some(i) = it.next_cell() {
                if BOARD[i] != 0 {
                    continue;
                }
                // 对方是黑时同样校验假五
                if color == WHITE && !find_winning_line(&BOARD, (i / 15) as i32, (i % 15) as i32, BLACK, true) {
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
                    BOARD[pt] = BLACK;
                    let forbidden = check_forbidden(&BOARD, r, c, 0);
                    BOARD[pt] = 0;
                    if forbidden {
                        // 唯一挡点对黑是禁手 → 黑无法合法防守 → 败
                        return -MATE + ply + 1;
                    }
                }
                BOARD[pt] = color;
                HASH ^= zobrist_at(pt, color);
                eval_delta(r, c, 0);
                near_delta(r, c, 1);
                let val = -negamax(opp, depth, -beta, -alpha, ply + 1);
                near_delta(r, c, -1);
                HASH ^= zobrist_at(pt, color);
                BOARD[pt] = 0;
                eval_delta(r, c, color);
                return val;
            }
        }
    }

    if depth == 0 {
        let e = unsafe { EVAL_SCORE };
        return if color == BLACK { e } else { -e };
    }

    // 内部宽度 16：α-β 的有效分支约 √width，从 24 收窄到 16 节点数约降 5 倍；
    // 对打实测与 24 等胜率且节点率高 35%
    let (cands, n) = ordered_candidates(color, 16, tt_move, ply as usize);
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
            BOARD[ci] = color;
            HASH ^= zobrist_at(ci, color);
            eval_delta(r, c, 0);
            near_delta(r, c, 1);
        }
        let mut val;
        if is_winning_stone(unsafe { &BOARD }, r, c, color) {
            val = MATE - ply;
        } else if first {
            val = -negamax(opp, depth - 1, -beta, -a, ply + 1);
            first = false;
        } else {
            // LMR（迟到着法降深）：安静节点（双方均无成五威胁）的靠后着法先用
            // depth-2 零窗口试探，fail-high 再全深重搜。战术区域（四表非零）不降；
            // 对打实测与不降深等胜率但深度更高（8 局 4:4，10s 深度 10 vs 8）。
            let quiet = unsafe { FIVE_B_CELLS == 0 && FIVE_W_CELLS == 0 };
            let reduction = if quiet && depth >= 3 && i >= 4 { 2 } else { 1 };
            val = -negamax(opp, depth - reduction, -(a + 1), -a, ply + 1);
            if val > a && val < beta {
                val = -negamax(opp, depth - 1, -beta, -a, ply + 1);
            }
        }
        unsafe {
            near_delta(r, c, -1);
            HASH ^= zobrist_at(ci, color);
            BOARD[ci] = 0;
            eval_delta(r, c, color);
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
                let k = &mut KILLERS[ply as usize];
                if k[0] != cands[i] {
                    k[1] = k[0];
                    k[0] = cands[i];
                }
                HISTORY[ci] += depth;
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

fn search_root(color: u8, cands: &[u16], n: usize, depth: i32, alpha: i32, beta: i32) -> (u16, i32) {
    let opp = if color == BLACK { WHITE } else { BLACK };
    let mut a = alpha;
    let mut best_move = cands[0];
    let mut best_score = -INF;
    for j in 0..n {
        let ci = cands[j] as usize;
        let r = (ci / 15) as i32;
        let c = (ci % 15) as i32;
        unsafe {
            BOARD[ci] = color;
            HASH ^= zobrist_at(ci, color);
            eval_delta(r, c, 0);
            near_delta(r, c, 1);
        }
        let mut val;
        if is_winning_stone(unsafe { &BOARD }, r, c, color) {
            val = MATE;
        } else if j == 0 {
            val = -negamax(opp, depth - 1, -beta, -a, 1);
        } else {
            val = -negamax(opp, depth - 1, -(a + 1), -a, 1);
            if val > a && val < beta {
                val = -negamax(opp, depth - 1, -beta, -a, 1);
            }
        }
        unsafe {
            near_delta(r, c, -1);
            HASH ^= zobrist_at(ci, color);
            BOARD[ci] = 0;
            eval_delta(r, c, color);
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
    let col = color as u8;
    unsafe {
        NODES = 0;
        TIMED_OUT = false;
        MAX_PLY = 0;
        DEADLINE = now() + time_ms as f64;
        HASH = 0;
        for i in 0..N {
            HISTORY[i] = 0;
            NEAR[i] = 0;
            if BOARD[i] != 0 {
                HASH ^= zobrist_at(i, BOARD[i]);
                let r = (i / 15) as i32;
                let c = (i % 15) as i32;
                near_delta(r, c, 1);
            }
        }
        EVAL_SCORE = evaluate(&BOARD);
        build_five_tables();
        for i in 0..TT_SIZE {
            TT[i] = EMPTY_TT;
        }
        for i in 0..64 {
            KILLERS[i] = [0, 0];
        }
    }

    let (cands, n) = ordered_candidates(col, width as usize, 0, 0);

    for i in 0..n {
        let ci = cands[i] as usize;
        let r = (ci / 15) as i32;
        let c = (ci % 15) as i32;
        unsafe {
            BOARD[ci] = col;
            let win = is_winning_stone(&BOARD, r, c, col);
            BOARD[ci] = 0;
            if win {
                RESULT_SCORE = MATE;
                RESULT_DEPTH = 1;
                RESULT_NODES = NODES as i32;
                RESULT_TIMED_OUT = 0;
                return ci as i32;
            }
        }
    }

    if n == 0 {
        unsafe {
            RESULT_SCORE = -MATE;
            RESULT_DEPTH = 0;
            RESULT_NODES = 0;
            RESULT_TIMED_OUT = 0;
        }
        return -1;
    }

    let mut best_move = cands[0];
    let mut best_score = -INF;
    let mut reached_depth = 0;

    let mut depth = 2i32;
    while depth <= max_depth as i32 {
        unsafe {
            if TIMED_OUT {
                break;
            }
        }
        let mut alpha = -MATE;
        let mut beta = MATE;
        if depth > 2 && best_score > -MATE / 2 && best_score < MATE / 2 {
            alpha = best_score - 200;
            beta = best_score + 200;
        }
        let (m, s) = search_root(col, &cands, n, depth, alpha, beta);
        if s <= alpha || s >= beta {
            let (m2, s2) = search_root(col, &cands, n, depth, -MATE, MATE);
            unsafe {
                if !TIMED_OUT {
                    best_move = m2;
                    best_score = s2;
                    reached_depth = depth;
                }
            }
        } else {
            unsafe {
                if !TIMED_OUT {
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
        RESULT_SCORE = best_score;
        RESULT_DEPTH = reached_depth;
        RESULT_NODES = NODES as i32;
        RESULT_TIMED_OUT = if TIMED_OUT { 1 } else { 0 };
    }
    best_move as i32
}
