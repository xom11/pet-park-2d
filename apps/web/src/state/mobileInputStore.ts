import { create } from "zustand";

// Mobile joystick + jump state. Joystick axes are in [-1, 1] with magnitude
// preserved so a half-push gives partial-throttle walking. Coordinate
// convention is +X right, +Y DOWN to match the game world (canvas-native).
// Jump is a one-shot pulse: tapping the button sets the flag, the renderer
// consumes it on the next frame so we never miss a tap between server ticks.

type MobileInputState = {
  joyX: number;
  joyY: number;
  jumpPulse: boolean;
  setJoy: (x: number, y: number) => void;
  resetJoy: () => void;
  pressJump: () => void;
  consumeJump: () => boolean;
};

export const useMobileInputStore = create<MobileInputState>((set, get) => ({
  joyX: 0,
  joyY: 0,
  jumpPulse: false,
  setJoy: (x, y) => set({ joyX: x, joyY: y }),
  resetJoy: () => set({ joyX: 0, joyY: 0 }),
  pressJump: () => set({ jumpPulse: true }),
  consumeJump: () => {
    const { jumpPulse } = get();
    if (jumpPulse) set({ jumpPulse: false });
    return jumpPulse;
  },
}));
