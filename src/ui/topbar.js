/** ui/topbar.js —— 顶部连接状态 + 主操作按钮 */
import { byId, setText, formatDuration } from './dom.js?v=20261023f';

export function mountTopbar(app) {
  const dot = byId('conn-dot');
  const status = byId('conn-status');
  const meta = byId('conn-meta');
  const roomId = byId('room-id');
  const sourceTag = byId('source-tag');
  const btnAnalyze = byId('btn-analyze');
  const btnReset = byId('btn-reset');

  btnAnalyze.addEventListener('click', () => app.toggleRun());
  btnReset.addEventListener('click', () => app.reset());

  window.addEventListener('beforeunload', () => app.dispose());

  return function render(state) {
    const { connection, running, raw } = state;

    dot.className = `dot dot-${connection.status === 'live' ? 'live' : connection.status === 'paused' ? 'paused' : connection.status === 'error' ? 'error' : 'idle'}`;

    const labelMap = {
      idle: '未连接',
      connecting: '连接中…',
      live: '直播中 · 采集中',
      paused: '已暂停',
      error: '连接异常',
    };
    setText(status, labelMap[connection.status] || connection.status);

    const pieces = [`房间 ${connection.roomId}`];
    if (connection.source === 'polyv') pieces.unshift('弹幕源：保利威聊天室');
    else pieces.unshift('弹幕源：本地模拟');
    if (connection.startedAt && connection.status !== 'idle') {
      pieces.push(`已运行 ${formatDuration(Date.now() - connection.startedAt)}`);
    }
    if (connection.lastMessageAt) pieces.push(`最后一条 ${formatDuration(Date.now() - connection.lastMessageAt)}前`);
    // 连接失败原因必须直接可见，而不是只留一个红点
    if (connection.message) pieces.push(connection.message);
    setText(meta, pieces.join(' · '));
    meta.classList.toggle('is-error', connection.status === 'error');

    setText(roomId, connection.roomId);
    setText(sourceTag, connection.source === 'polyv' ? 'polyv' : 'mock（演示数据）');

    btnAnalyze.textContent = running ? '暂停分析' : (raw.length ? '继续分析' : '开始分析');
    btnAnalyze.classList.toggle('btn-primary', !running);
  };
}
