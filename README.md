# Fashion Studio Runway

A 3D dress-up game for kids: pick a dress, paint your own design, style your model, and send her down the runway.

**Play:** https://tonywhite11.github.io/fashion-studio-runway/ (works on iPad, phones and PC).
On iPad, open it in Safari, then Share → **Add to Home Screen** for a full-screen app icon.

## What's in it
- 14 dresses, including Hanbok, Idol, Ninja, Kurta Suruwal, Gunyu Cholo and Haku Patasi
- Paint: brushes, rainbow, glitter, eraser, fill, gradients, 8 colors plus a color wheel and "My colors"
- Fun: 21 patterns (Dhaka, Rhododendron, Lotus, Himalaya and more), 46 stickers including a Nepal flag, sticker resize
- Look: skin, eyes, hair color, 13 hairstyles, 6 expressions, 21 accessories, shoes
- 👗 My Closet: save whole outfits and wear them again
  - 📤 Share an outfit as a code (lasts 30 days); 📥 Get an outfit with your sister's code
- 📸 Photo with a Save button
- ❓ How to Play screen (opens by itself the first time)
- Runway: 8 stages (including Tihar Lights), 6 music tracks, 9 poses
  - Up, down and up the runway, then a bow with confetti, applause and 🔁 Encore
  - 👯 Walk with a friend: two models side by side, wearing a closet outfit
  - 🎙️ Announcer: Claude looks at the outfit(s) and writes a short, witty introduction; ElevenLabs reads it aloud

## Saving
Everything saves automatically in the browser on each device (no accounts). Shared outfits and announcer
requests go to the small backend below; nothing else is uploaded.
Clearing the browser's website data erases saved drawings and outfits.

## Tech
- Game: a single `index.html` using three.js (loaded from a CDN). Deploy = push to `main` (GitHub Pages).
- Backend: `worker/` is a Cloudflare Worker (share codes in KV, Claude + ElevenLabs announcer). See `worker/README.md`.
