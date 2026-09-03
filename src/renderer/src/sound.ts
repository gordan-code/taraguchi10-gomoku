/** 极简音效：WebAudio 合成落子声，无需音频资源文件 */
let ctx: AudioContext | null = null

export function playStoneClick(): void {
  try {
    ctx = ctx ?? new AudioContext()
    if (ctx.state === 'suspended') void ctx.resume()
    const t = ctx.currentTime
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.type = 'sine'
    osc.frequency.setValueAtTime(640, t)
    osc.frequency.exponentialRampToValueAtTime(180, t + 0.09)
    gain.gain.setValueAtTime(0.18, t)
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.11)
    osc.connect(gain)
    gain.connect(ctx.destination)
    osc.start(t)
    osc.stop(t + 0.12)
  } catch {
    /* 音频不可用时静默忽略 */
  }
}
