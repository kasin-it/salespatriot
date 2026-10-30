# Demo assets (Scenario 2 fallback)

Two sets of **DEMO FIXTURES** — fictional products by fictional manufacturers, watermarked in every file:

| Set | Product | Files |
| --- | --- | --- |
| `thermal/` | Demo Optronics TI-640 thermal imaging camera | flyer photo, spec PDF, presentation PDF, conversation transcript |
| `drone/` | Demo Aerospace SK-4 tactical reconnaissance UAS (military drone) | flyer photo, spec PDF, presentation PDF, conversation transcript |

Facts are consistent inside each set (thermal: 1180 EUR at 200+, 6 weeks, MOQ 50; drone: 14500 EUR per system at 10+, 10 weeks, MOQ 5; ISO 9001 / AQAP 2110).
**Payment and delivery terms are deliberately missing** so the "gaps" panel has something real to flag. The transcript files stand in for speech-to-text output.

## Using a real photo of the drone you have in the room
Attach your own photo in the *Salesperson's phone* card (it can be sent together with the fixture spec PDF). The vision model describes what it sees
("quadcopter with four rotors and a gimbal camera") as a *visual observation, not verified*; it does not invent specifications, price or manufacturer.

## Matching the fixture to your physical drone
Edit `drone/product.json` (name, manufacturer, rows, prices) and regenerate on macOS: `cd apps/api/demo-assets && swift generate.swift drone`.

The *Prepared reply* buttons email every file in the chosen set from the salesperson's address. Replies built from these files are marked as fixtures: they never
create capability claims about a real company. `generate.swift <set>` rebuilds the photo and PDFs from `<set>/product.json`.
