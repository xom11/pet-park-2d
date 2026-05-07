import { useEffect, useRef } from "react";
import { create as createJoystick } from "nipplejs";
import { useMobileInputStore } from "../state/mobileInputStore";

type JoystickHandle = ReturnType<typeof createJoystick>;

// On-screen analog joystick (left) + jump button (right). The wrapping
// `.mobile-controls` div is hidden via CSS unless the device has a coarse
// pointer (touch), so desktop players never see it.
export function MobileControls() {
  const zoneRef = useRef<HTMLDivElement>(null);
  const managerRef = useRef<JoystickHandle | null>(null);

  useEffect(() => {
    if (!zoneRef.current) return;
    const manager = createJoystick({
      zone: zoneRef.current,
      mode: "static",
      position: { left: "50%", top: "50%" },
      size: 80,
      color: "#e6e9f2",
      restOpacity: 0.55,
      threshold: 0.05,
    });
    managerRef.current = manager;

    manager.on("move", (evt) => {
      const data = evt?.data;
      if (!data?.vector) return;
      // nipplejs vector: x right=+1, y up=+1. Game world uses +Y DOWN, so we
      // flip the sign of y. force is already clamped in [0, 1].
      const force = Math.min(1, data.force ?? 0);
      const x = data.vector.x * force;
      const y = -data.vector.y * force;
      useMobileInputStore.getState().setJoy(x, y);
    });
    manager.on("end", () => useMobileInputStore.getState().resetJoy());

    return () => {
      manager.destroy();
      managerRef.current = null;
      useMobileInputStore.getState().resetJoy();
    };
  }, []);

  // Use pointerdown so the button reacts before the synthetic click and
  // doesn't fight the joystick for touches. preventDefault stops iOS from
  // emitting a 300 ms click + scroll.
  const handleJump = (e: React.PointerEvent) => {
    e.preventDefault();
    useMobileInputStore.getState().pressJump();
  };

  return (
    <div className="mobile-controls" aria-hidden>
      <div
        className="mobile-joystick-zone"
        ref={zoneRef}
        onTouchStart={(e) => e.preventDefault()}
      />
      <button
        type="button"
        className="mobile-jump-button"
        onPointerDown={handleJump}
      >
        Jump
      </button>
    </div>
  );
}
