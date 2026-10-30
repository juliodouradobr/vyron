import { create } from 'zustand';
import type { GatewayState } from '../services/gateway';

interface ConnectionState {
  state: GatewayState;
  latencyMs: number | null;
  retryAt: number | null;
  set(partial: Partial<Omit<ConnectionState, 'set'>>): void;
}

export const useConnection = create<ConnectionState>((set) => ({
  state: 'idle',
  latencyMs: null,
  retryAt: null,
  set: (partial) => set(partial),
}));
