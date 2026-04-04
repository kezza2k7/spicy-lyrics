# Spicy Lyrics

### Check out our *[Sitee](https://yoursit.ee/lyrics)*
#### Make your own at -> [https://yoursit.ee](https://yoursit.ee)

# How to install Spicy Lyrics

## 1. Using the Spicetify Marketplace (recommended)
1. Search `Spicy Lyrics` under the "Extensions" tab
2. Click the Install button on the Spicy Lyrics extension
3. All done!

## 2. Externally (not recommended)
1. Make sure you have [Spicetify](https://spicetify.app) installed
2. Download the [spicy-lyrics.mjs](./builds/spicy-lyrics.mjs) file
3. Put the file inside the Spicetify Extensions directory. Find the correct directory here: [https://spicetify.app/docs/customization/extensions#manual-installation](https://spicetify.app/docs/customization/extensions#manual-installation)
4. Then, run ```spicetify config extensions spicy-lyrics.mjs```
5. Then apply Spicetify by running ```spicetify apply```
6. All done!

[![Github Version](https://img.shields.io/github/v/release/spikerko/spicy-lyrics)](https://github.com/spikerko/spicy-lyrics/) [![Github Stars badge](https://img.shields.io/github/stars/spikerko/spicy-lyrics?style=social)](https://github.com/spikerko/spicy-lyrics/) [![Discord Badge](https://dcbadge.limes.pink/api/server/uqgXU5wh8j?style=flat)](https://discord.com/invite/uqgXU5wh8j)

Hi, I'm Spikerko (the person who made this repo). I've been really passionate about this project, and I'm really happy for this project.

I've seen a problem with the Spotify Lyrics. They're plain, just static colors. So I wanted to build my own version. And here it is: **Spicy Lyrics**. Hope you like it!

![Extension Example](./previews/page.gif)


*Inspired by [Beautiful Lyrics](https://github.com/surfbryce/beautiful-lyrics)*

## TypeScript Backend (Express)

This repository now includes a TypeScript backend in [backend/server.ts](backend/server.ts) for lyrics proxying.

### Run

1. Install dependencies
2. Start backend: `npm run backend`
3. Health check: `GET /health`

### Environment variables

- `PORT` (default: `3000`)
- `SPOTIFY_BEARER_TOKEN` (optional fallback if token is not passed in request headers/body)
- `APPLE_MUSIC_DEVELOPER_TOKEN` (required for Apple lyrics unless passed per request)

### Endpoints

- `POST /query`
- `POST /spotify/lyrics`
- `POST /apple/lyrics`

The `POST /query` endpoint is compatible with the existing frontend query contract and supports:

- `operation: "lyrics"` (Spotify first, optional Apple fallback)
- `operation: "spotifyLyrics"`
- `operation: "appleLyrics"`
