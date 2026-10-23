/**
 * ui/aiPanel.js —— AI 洞察面板
 * ------------------------------------------------------------
 * 只订阅 aiStore（AI 自己的状态），不介入 core 面板的渲染；
 * 关闭开关时仅停止批次调度，core 的过滤/分类/聚合/告警完全不受影响。
 */
import { byId, setText, toggleClass, toast, formatTime } from './dom.js?v=20261023f';
import { AI_STATUS_LABELS } from '../ai/schema.js?v=20261023f';
import { renderInsightHtml } from './aiInsightView.js?v=20261023f';

/** 不同状态下的占位说明 */
function emptyText(status, error) {
  switch (status) {
    case 'disabled':
      return 'AI 洞察已关闭。弹幕的过滤、分类、聚合与告警仍照常运行，互不影响。';
    case 'loading':
      return '正在生成洞察…';
    case 'unavailable':
      return '未检测到 AI 服务（纯静态模式）。核心分析不受影响；需要 AI 面板时用 npm run dev 启动本地服务。';
    case 'error':
      return `生成失败：${error || '未知错误'}。核心分析不受影响，可点「重试」。`;
    case 'waiting':
      return '等待有效弹幕进入后再生成洞察（默认每 15 秒一批）。';
    case 'idle':
      return '开启后，每个批次会把结构化摘要交给 AI 生成洞察。';
    default:
      return '暂无洞察';
  }
}

export function mountAiPanel({ app, aiStore, aiBatcher }) {
  const sw = byId('sw-ai');
  const statusEl = byId('ai-status');
  const metaEl = byId('ai-meta');
  const contentEl = byId('ai-content');
  const emptyEl = byId('ai-empty');
  const nowBtn = byId('btn-ai-now');
  const retryBtn = byId('btn-ai-retry');
  const modeTagEl = byId('ai-mode-tag');

  const initial = aiStore.getState();
  if (sw) sw.checked = initial.enabled;

  if (sw) {
    sw.addEventListener('change', () => {
      aiStore.setEnabled(sw.checked);
      if (sw.checked) {
        aiBatcher.start();
        toast('已开启 AI 洞察');
      } else {
        aiBatcher.stop();
        toast('已关闭 AI 洞察，弹幕筛查与分类不受影响');
      }
    });
  }

  nowBtn?.addEventListener('click', async () => {
    if (!aiStore.getState().enabled) {
      toast('请先开启 AI 洞察');
      return;
    }
    const res = await aiBatcher.runNow();
    if (res?.ok) toast('AI 洞察已更新');
    else if (res?.skipped) toast('暂无可分析的有效弹幕');
  });

  retryBtn?.addEventListener('click', async () => {
    aiStore.setStatus('waiting', { backendAvailable: null, lastError: '' });
    const res = await aiBatcher.runNow();
    if (res?.ok) toast('AI 洞察已更新');
    else if (res?.unavailable) toast('仍未检测到 AI 服务');
  });

  return function render() {
    const s = aiStore.getState();

    if (sw) sw.checked = s.enabled;
    setText(statusEl, AI_STATUS_LABELS[s.status] || s.status);
    if (statusEl) {
      const tone = s.status === 'ok' ? 'tag tag-ai-ok'
        : s.status === 'error' || s.status === 'unavailable' ? 'tag tag-warn'
          : s.status === 'loading' ? 'tag tag-primary'
            : 'tag tag-muted';
      statusEl.className = tone;
    }

    // 模式标签：后端返回 real 才是真实模型，其余（含回退）都标模拟
    if (modeTagEl) {
      const real = s.insight?.mode === 'real';
      modeTagEl.textContent = real ? '真实模型' : '模拟输出';
      modeTagEl.className = real ? 'tag tag-ai' : 'tag tag-muted';
    }

    const metaParts = [];
    if (s.lastRunAt) metaParts.push(`更新于 ${formatTime(s.lastRunAt)}`);
    if (s.lastLatencyMs) metaParts.push(`耗时 ${s.lastLatencyMs}ms`);
    if (s.insight?.model) metaParts.push(`模型 ${s.insight.model}`);
    if (s.successCount) metaParts.push(`累计 ${s.successCount} 批`);
    setText(metaEl, metaParts.join(' · ') || '尚未生成');

    const hasInsight = !!(s.insight && s.insight.summary);
    const showContent = s.enabled && hasInsight;
    toggleClass(contentEl, 'hidden', !showContent);
    toggleClass(emptyEl, 'hidden', showContent);
    if (showContent) {
      contentEl.innerHTML = renderInsightHtml(s.insight);
    } else {
      contentEl.innerHTML = '';
      setText(emptyEl, emptyText(s.status, s.lastError));
    }

    if (retryBtn) toggleClass(retryBtn, 'hidden', !(s.status === 'error' || s.status === 'unavailable'));
    if (nowBtn) nowBtn.disabled = !s.enabled;
    toggleClass(byId('card-ai'), 'is-ai-off', !s.enabled);
    // 保留 app 引用，便于将来做「点击某条建议 → 高亮对应弹幕」的联动
    void app;
  };
}
