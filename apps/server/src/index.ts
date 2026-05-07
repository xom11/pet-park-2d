import { Server } from "@colyseus/core";
import { WebSocketTransport } from "@colyseus/ws-transport";
import { ROOM_NAME } from "@pet-park-2d/shared";
import { ParkRoom } from "./rooms/ParkRoom";

// 2D server runs on a different port from the 3D sibling so both can run side
// by side on the same machine during development.
const port = Number(process.env.PORT ?? 2568);

const gameServer = new Server({
  transport: new WebSocketTransport(),
});

gameServer.define(ROOM_NAME, ParkRoom);

await gameServer.listen(port);
console.log(`[pet-park-2d] game server listening on ws://localhost:${port}`);
