# Buddy voice discussion

Open **Voice chat**, choose a voice, and press **Start conversation**. Allow microphone access. Speak normally; a short pause commits the turn. New speech interrupts playback and cancels the current response. Mute, Interrupt, and End conversation are always available. Closing voice mode, switching conversations, leaving the chat, or hiding the tab stops capture and playback.

Voice discussion uses the same authenticated conversation and authorized Buddy tools. Voice turns request short spoken prose and bypass chart, diagram, quiz, sticky-note, and interactive follow-up policies. A necessary clarification is a short spoken question. Ordinary text turns retain the existing chat interface. **Read aloud** is also available on completed replies; structured blocks, tables, reasoning, and follow-up forms are excluded from speech.

## Server configuration

Provide `ELEVENLABS_API_KEY` to the app container, or store an administrator-managed JSON configuration at `/root/.bob/elevenlabs.json` (the existing `.bob-private` bind mount). Set file permissions to `0600` and exclude it from source control. Supported configuration keys are `api_key`, `voice_id`, and `model_id`. `ELEVENLABS_CONFIG_FILE` overrides the path; environment variables override file values. No provider credential is exposed to the browser.

Live discussion uses ElevenLabs Scribe v2 Realtime for speech recognition and Flash v2.5 for streaming speech. Microphone PCM streams through `/voice/listen`; reply text and PCM audio stream through `/voice/speak`. Existing text-chat generation uses its existing HTTP event stream. `/voice/speech` provides an authenticated HTTP audio fallback API. `/voice/voices` lists voices available to the configured account. A voice may be listed but still require a paid subscription; choose a standard voice or check provider credits when that happens.

Microphone access requires HTTPS, or localhost during development, and a browser supporting Web Audio and AudioWorklet. The reverse proxy must forward WebSocket upgrades; the supplied HTTPS nginx configuration already does. Capture requests echo cancellation, noise suppression, and automatic gain control. Headphones improve interruption detection when speaker output is audible to the microphone. Real-world latency and echo behavior depend on the device, network, provider, and Buddy's response generation; streaming does not remove tool or model processing time.

Sockets require the signed-in user's cookie and matching Origin/Host. Server-side concurrency, message-size, character, audio-rate, and session-duration bounds apply. Listening sessions end after 15 minutes and can be restarted. Generated audio is not stored by the app; microphone audio and reply text are sent to ElevenLabs and subject to the account's provider settings.

## Verification

- `tests/test_voice.py`: HTTP/WebSocket authentication, error redaction, bounds, slot cleanup, provider protocol, and discussion policy.
- `tests/test_voice_frontend.mjs`: prose filtering and chunk bounds.
- `tests/test_voice_browser.py`: Chromium test microphone, real AudioWorklet/Web Audio, synthetic provider sockets, streaming before generation ends, interruption, mute, mobile layout, and cleanup.

Provider connectivity and short speech generation must be tested separately with a real server key. Browser fixtures verify application behavior; they do not measure acoustic echo cancellation or human conversation latency.

## Notes actions by voice

You can ask “What notes did I create today?”, “Read my latest note”, or “Create a note about what we just discussed.” The built-in `buddy-app` tool server reads the signed-in user's actual private notes. An explicit voice request to create/save a note saves it directly, then Buddy confirms the actual saved title. Text chat retains draft note cards unless the user explicitly requests saving. “Today” means the browser timezone's calendar day, filtered on creation time.

Notes tool identity and source conversation are fixed by the worker. A turn-local note index makes retries reuse the saved note rather than creating duplicates. Successful writes emit a `notes_changed` event so the Notes UI refreshes. The tools currently cover listing, searching, reading, and creating Notes; they do not grant arbitrary UI scripting, deletion, or external publishing.
