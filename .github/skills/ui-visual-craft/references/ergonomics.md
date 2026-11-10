# Ergonomics: hands, eyes, devices

Source: `frontend/DESIGN_GUIDELINES.md` §10.2. Units differ across sources (CSS px, pt, dp, mm); never read the same number as the same physical size.

## Target size and spacing
- Pointer targets 24 by 24 CSS px or more (WCAG 2.5.8 AA, exceptions exist). Primary, frequent and touch targets 44 by 44 (WCAG 2.5.5 AAA as a design goal, Apple 44 pt on iOS, Material pointer minimum 44 dp). Material and Android use 48 dp (about 9 mm) for touch.
- Visual size is not hit area: a 24 dp icon may sit in a 48 dp target through padding. If widening would overlap a neighbour, keep the size and add spacing instead.
- Spacing matters as much as size (Apple, Material, Android): 8 dp or more between targets; about 12 pt around bezeled controls on Apple platforms.
- Keep irreversible actions away from daily ones.

## Hands
- Observed holds while touching (Hoober 2013, 780 people): one hand 49%, cradled 36%, two hands 15%; people switch grip every few seconds. No demographics, so do not generalise the ratios. Support all three; do not build a single "thumb zone" rule.
- Thumb study (Parhi et al. 2006): about 9.2 to 9.6 mm targets were sufficient; larger was faster.

## Input devices
- `@media (pointer: coarse)` enlarges touch targets; `(pointer: fine)` is a mouse. `any-pointer` covers every connected device (mixed laptops). `(hover: none)` means hover is unavailable or inconvenient, so hover-only information needs another path.
- Never infer touch from screen width.

## Eyes and viewport
- Visual angle is roughly letter height divided by distance, so doubling the distance needs double the size. Kiosks, TVs and meeting-room screens need their own text and target sizes.
- Body text starts at 16 px in `rem` (KRDS body 16 px or more, line height 150% or more). The figures 16 arcmin floor and 20 to 22 arcmin preferred come from a secondary summary of ISO 9241-303 and are only a reference.
- `100vh` equals `lvh` (browser UI retracted); on mobile it can hide the bottom. Use `dvh` or `svh` for full-height layouts and `env(safe-area-inset-bottom)` for fixed bottom bars.

## Check
`element-inventory.mjs --viewport 390x844` flags `SIZE-TARGET-24` and `SIZE-TARGET-44`. It cannot see spacing, grip, the virtual keyboard or distance; try a real device or emulator with one hand and two.
