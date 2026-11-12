import type { Deps } from '../deps.js';
import type { Message } from '../types.js';
import { A2A_GATEWAY_ID } from './constants.js';
import { agentMessage } from './protocol.js';

/** When a bot replies on an inbound A2A thread, fold that text into the task result. */
export function completeInboundFromReply(deps: Deps, message: Message): void {
  if (message.toId !== A2A_GATEWAY_ID) return;
  const task = deps.db.activeInboundTask(message.fromId, message.threadId);
  if (!task) return;
  const history = [...task.history, agentMessage(task, message.body)];
  deps.db.completeA2aTask(task.id, message.body, history, deps.now());
}
