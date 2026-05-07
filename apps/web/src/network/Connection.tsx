import { useEffect } from "react";
import { Client, type Room } from "colyseus.js";
import { ROOM_NAME, type AnimationState } from "@pet-park-2d/shared";
import {
  networkActions,
  useNetworkStore,
  type RemoteSnapshot,
} from "../state/networkStore";

// In dev, derive the host from the page so a phone hitting the dev machine
// over LAN (e.g. http://192.168.x.y:5174) talks to the same IP on the game
// server port — "localhost" would resolve to the phone itself.
function defaultServerUrl(): string {
  if (typeof window === "undefined") return "ws://localhost:2568";
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.hostname}:2568`;
}

const SERVER_URL =
  (import.meta.env.VITE_SERVER_URL as string | undefined) ?? defaultServerUrl();

let activeRoom: Room | null = null;

export function getRoom(): Room | null {
  return activeRoom;
}

type ServerPlayer = {
  sessionId: string;
  petId: string;
  name: string;
  x: number;
  y: number;
  anim: string;
};

function snapshotFrom(p: ServerPlayer): RemoteSnapshot {
  return {
    sessionId: p.sessionId,
    petId: p.petId,
    name: p.name,
    x: p.x,
    y: p.y,
    anim: (p.anim as AnimationState) ?? "idle",
  };
}

export function Connection() {
  useEffect(() => {
    let cancelled = false;
    let joinedRoom: Room | null = null;
    const client = new Client(SERVER_URL);

    (async () => {
      try {
        const room = await client.joinOrCreate(ROOM_NAME);
        if (cancelled) {
          await room.leave().catch(() => {});
          return;
        }
        joinedRoom = room;
        activeRoom = room;
        networkActions.setSessionId(room.sessionId);

        room.onStateChange((rawState) => {
          const state = rawState as { players: Map<string, ServerPlayer> };
          const seen = new Set<string>();
          state.players.forEach((p, sid) => {
            seen.add(sid);
            const known = useNetworkStore
              .getState()
              .playerIds.includes(sid);
            const snap = snapshotFrom(p);
            if (known) {
              networkActions.updatePlayer(snap);
            } else {
              networkActions.addPlayer(snap);
            }
          });
          for (const id of useNetworkStore.getState().playerIds) {
            if (!seen.has(id)) networkActions.removePlayer(id);
          }
        });

        room.onLeave(() => {
          if (activeRoom === room) activeRoom = null;
          networkActions.reset();
        });

        room.onError((code, message) => {
          console.error("[network] room error", code, message);
        });
      } catch (err) {
        if (!cancelled) console.error("[network] join failed:", err);
      }
    })();

    return () => {
      cancelled = true;
      if (joinedRoom) {
        joinedRoom.leave().catch(() => {});
        if (activeRoom === joinedRoom) activeRoom = null;
      }
      networkActions.reset();
    };
  }, []);

  return null;
}
