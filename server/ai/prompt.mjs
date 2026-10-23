/**
 * server/ai/prompt.mjs —— 服务端 Prompt（与前端共用的转发层）
 * ------------------------------------------------------------
 * 真正的 Prompt 文本在 src/ai/prompt.js（前端云端直调也用同一份），
 * 这里只做 re-export，保证两条通道指令一致。
 */
export { SYSTEM_PROMPT, buildUserPrompt, RETRY_REMINDER } from '../../src/ai/prompt.js';
