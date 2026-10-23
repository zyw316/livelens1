/** ui/controlPanel.js —— 弹幕源选择、手动注入、算法参数调节 */
import { byId, setText, toast } from './dom.js?v=20261023f';
import { createDenoiseEngine } from '../core/denoise.js?v=20261023f';
import { CONFIG } from '../config.js?v=20261023f';
import { SOURCE } from '../core/constants.js?v=20261023f';
import { createRoomModal } from './roomModal.js?v=20261023f';

function sensitivityLabel(v) {
  if (v >= 80) return '严格';
  if (v >= 45) return '均衡';
  return '宽松';
}

export function mountControlPanel(app) {
  const selSource = byId('sel-source');
  const injectInput = byId('inject-text');
  const btnInject = byId('btn-inject');
  const rngSens = byId('rng-sensitivity');
  const valSens = byId('val-sensitivity');
  const hintSens = byId('hint-sensitivity');
  const rngSim = byId('rng-similarity');
  const valSim = byId('val-similarity');
  const swDenoise = byId('sw-denoise');
  const swNoiseVisible = byId('sw-noise-visible');

  // 保利威未启用时把该选项置灰，避免用户切过去只看到一个无意义的报错
  const polyvOption = selSource.querySelector('option[value="polyv"]');
  if (polyvOption) polyvOption.disabled = CONFIG.polyv.enabled !== true;

  // 「连接直播间」频道号弹窗：切到保利威必须先输入目标频道号，确认后才真正连接 SDK
  const roomModal = createRoomModal();

  selSource.addEventListener('change', (e) => {
    const value = e.target.value;
    if (value === SOURCE.POLYV && CONFIG.polyv.enabled) {
      const previous = app.getState().connection.source;
      roomModal.open({
        defaultChannel: CONFIG.polyv.channelId,
        // 确认：带上频道号切换数据源，main.js 会立即执行 SDK 连接并回传结果
        onConfirm: (channelId) => app.switchSource(SOURCE.POLYV, channelId),
        // 取消：当无事发生——回滚下拉框；若已切到 polyv（连接失败留存），恢复此前的弹幕源
        onCancel: async () => {
          selSource.value = previous;
          if (app.getState().connection.source !== previous) {
            await app.switchSource(previous);
          }
        },
      });
    } else {
      app.switchSource(value);
    }
  });

  const doInject = () => {
    const text = injectInput.value.trim();
    if (!text) return;
    app.injectDanmaku(text);
    injectInput.value = '';
    toast(`已注入：${text}`);
  };
  btnInject.addEventListener('click', doInject);
  injectInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') doInject();
  });

  rngSens.addEventListener('input', (e) => app.setOption('sensitivity', Number(e.target.value)));
  rngSim.addEventListener('input', (e) => app.setOption('clusterThreshold', Number(e.target.value)));
  swDenoise.addEventListener('change', (e) => app.setOption('enableDenoise', e.target.checked));
  swNoiseVisible.addEventListener('change', (e) => app.setUi('showNoise', e.target.checked));

  return function render(state) {
    const sens = state.options.sensitivity;
    const sim = state.options.clusterThreshold;
    setText(valSens, `${sens} · ${sensitivityLabel(sens)}`);
    setText(valSim, Number(sim).toFixed(2));
    if (rngSens.value !== String(sens)) rngSens.value = String(sens);
    if (Number(rngSim.value) !== Number(sim)) rngSim.value = String(sim);
    if (swDenoise.checked !== state.options.enableDenoise) swDenoise.checked = state.options.enableDenoise;

    // 展示敏感度实际影响了哪些参数（直接读取去噪引擎的配置）
    const { config } = createDenoiseEngine({ sensitivity: sens });
    setText(
      hintSens,
      `最短有效 ${config.minLen} 字 · 去重窗口 ${(config.dupWindowMs / 1000).toFixed(0)}s · 无信息过滤${config.enableLowInfo ? '开' : '关'}`,
    );

    setText(byId('source-tag'), state.connection.source === 'polyv' ? 'polyv' : 'mock（演示数据）');
  };
}
