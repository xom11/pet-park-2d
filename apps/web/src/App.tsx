import { Connection } from "./network/Connection";
import { GameCanvas } from "./game/GameCanvas";
import { MobileControls } from "./controls/MobileControls";
import { useNetworkStore } from "./state/networkStore";

export function App() {
  const connected = useNetworkStore((s) => s.connected);
  const playerCount = useNetworkStore((s) => s.playerIds.length);

  return (
    <>
      <Connection />
      <GameCanvas />
      <div className="hud">
        <strong>pet-park-2d</strong> · v0 ·{" "}
        <span className="hud-desktop-only">
          <kbd>WASD</kbd> move · <kbd>Space</kbd> jump
        </span>
        <span className="hud-mobile-only">stick: move · Jump button</span>
      </div>
      <div className={`player-count${connected ? "" : " disconnected"}`}>
        <span className="dot" />
        {connected ? `${playerCount} online` : "connecting…"}
      </div>
      <MobileControls />
    </>
  );
}
