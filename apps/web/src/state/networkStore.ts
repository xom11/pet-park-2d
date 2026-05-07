import { create } from "zustand";
import type { AnimationState } from "@pet-park-2d/shared";

export type RemoteSnapshot = {
  sessionId: string;
  petId: string;
  name: string;
  x: number;
  y: number;
  anim: AnimationState;
};

type NetworkState = {
  sessionId: string | null;
  playerIds: string[];
  connected: boolean;
};

export const useNetworkStore = create<NetworkState>(() => ({
  sessionId: null,
  playerIds: [],
  connected: false,
}));

// Snapshots live outside React state so per-tick mutation does not trigger
// re-renders. The render loop reads them via getSnapshot() inside RAF.
const snapshots = new Map<string, RemoteSnapshot>();

export function getSnapshot(sessionId: string): RemoteSnapshot | undefined {
  return snapshots.get(sessionId);
}

export function getAllSnapshots(): RemoteSnapshot[] {
  return [...snapshots.values()];
}

export const networkActions = {
  setSessionId(id: string) {
    useNetworkStore.setState({ sessionId: id, connected: true });
  },
  addPlayer(snap: RemoteSnapshot) {
    snapshots.set(snap.sessionId, snap);
    useNetworkStore.setState((s) =>
      s.playerIds.includes(snap.sessionId)
        ? s
        : { playerIds: [...s.playerIds, snap.sessionId] },
    );
  },
  updatePlayer(snap: RemoteSnapshot) {
    snapshots.set(snap.sessionId, snap);
  },
  removePlayer(id: string) {
    snapshots.delete(id);
    useNetworkStore.setState((s) => ({
      playerIds: s.playerIds.filter((x) => x !== id),
    }));
  },
  reset() {
    snapshots.clear();
    useNetworkStore.setState({
      sessionId: null,
      playerIds: [],
      connected: false,
    });
  },
};
