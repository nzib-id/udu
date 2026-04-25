import { NETWORK_CONFIG } from '../../../shared/config';
import type { ClientMessage, ServerMessage } from '../../../shared/types';

export type ConnectionStatus = 'connecting' | 'open' | 'closed' | 'error';

export type SocketOpts = {
  onState: (state: Extract<ServerMessage, { type: 'state_update' }>) => void;
  onStatus: (status: ConnectionStatus) => void;
};

export function connectGameSocket(opts: SocketOpts): void {
  const { onState, onStatus } = opts;
  let attempt = 0;
  let ws: WebSocket | null = null;
  let heartbeat: number | null = null;

  const url = buildWsUrl();

  const open = (): void => {
    onStatus('connecting');
    ws = new WebSocket(url);

    ws.addEventListener('open', () => {
      attempt = 0;
      onStatus('open');
      send({ type: 'request_full_state' });
      heartbeat = window.setInterval(() => send({ type: 'heartbeat' }), 15_000);
    });

    ws.addEventListener('message', (ev) => {
      let msg: ServerMessage;
      try {
        msg = JSON.parse(ev.data as string) as ServerMessage;
      } catch {
        return;
      }
      if (msg.type === 'state_update') {
        onState(msg);
      } else if (msg.type === 'pong') {
        // noop
      } else {
        console.log('[ws] message:', msg);
      }
    });

    ws.addEventListener('close', () => {
      if (heartbeat) window.clearInterval(heartbeat);
      heartbeat = null;
      onStatus('closed');
      scheduleReconnect();
    });

    ws.addEventListener('error', () => {
      onStatus('error');
    });
  };

  const send = (msg: ClientMessage): void => {
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  };

  const scheduleReconnect = (): void => {
    const delays = NETWORK_CONFIG.reconnectBackoffMs;
    const delay = delays[Math.min(attempt, delays.length - 1)];
    attempt++;
    window.setTimeout(open, delay);
  };

  open();
}

function buildWsUrl(): string {
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${window.location.host}${NETWORK_CONFIG.wsPath}`;
}
