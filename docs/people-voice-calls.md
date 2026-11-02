# People voice calls on port 443

The default calling transport is `PEOPLE_AUDIO_TRANSPORT=websocket`. Browsers use the **same HTTPS/WSS origin as Buddy**, such as `https://192.0.2.10/`, for signaling and audio. They do not need access to Docker service addresses, TURN ports or UDP relay ranges. Existing core and HTTPS proxies already forward WebSocket upgrades.

Click the phone button in a direct conversation. The recipient can Answer or Decline while chat is minimized. Incoming calls do not access the microphone before Answer. Ringback/ringtone, mute/unmute and Hang up remain available. The unanswered window is 45 seconds, supplied as a server countdown so device clock differences cannot end a call after one ring. Only an explicit Decline action reports declined; microphone, connection and timeout failures retain their actual reasons.

## Secure audio transport

The existing authenticated signaling socket is `/api/community/calls/ws?audio=1`. After acceptance each participant opens `/api/community/calls/{call_id}/audio` on the **same origin and port**. The audio handshake requires the authenticated user, the call ID, the unpredictable owning signaling-client ID and a public ECDH key. Another browser tab or nonmember cannot claim that connection.

Each browser generates a fresh P-256 ECDH key pair and derives an AES-GCM audio key locally. Audio packets include a unique direction-specific nonce/counter and authenticate the call ID and sender role. Receivers reject replayed counters and authenticate before playback. The server forwards opaque encrypted packets and public keys; private keys never leave the browser. PCM, ciphertext and recordings are not stored in database rows or sent to an AI model. PostgreSQL notifications distribute the opaque packets across service processes.

Audio capture/playback reuse Buddy's Web Audio/AudioWorklet approach, with mono PCM16 at 16 kHz. The server bounds packet size and rate and repeatedly validates login, room membership and socket ownership. Revocation, hang-up and disconnect end the call and release microphone/audio resources. A call becomes connected after the browser actually decrypts received audio packets. If browser autoplay blocks sound, Play call audio resumes playback through a user gesture.

References: [AudioWorkletNode](https://developer.mozilla.org/en-US/docs/Web/API/AudioWorkletNode), [Web Crypto deriveKey](https://developer.mozilla.org/en-US/docs/Web/API/SubtleCrypto/deriveKey), [binary WebSockets](https://developer.mozilla.org/en-US/docs/Web/API/WebSocket/binaryType).

## Deployment

Build/recreate the People plugin and rebuild the frontend. Existing tabs need **one reload to load the new calling code**. The signaling server gives old calling clients a clear update message before attempting an incompatible call. Message delivery itself does not require page refreshes.

Separate TURN listeners are stopped in the current 443-only deployment. Optional legacy WebRTC code/configuration remains available only for an explicitly selected `PEOPLE_AUDIO_TRANSPORT=webrtc` deployment; it is not used by default calls. No public STUN service is silently selected.

## Live messages

The message POST returns the saved serialized message for immediate sender display. Clients requesting `/api/community/ws?messages=1` receive recipient-scoped message events. Older clients receive refresh notifications. Reconciliation snapshots reject stale results after live delivery. The composer remains focused when Enter sends a message, allowing the next message to be typed immediately.

## Verification

- `tests/people_socket_audio_browser.mjs`: two disposable authenticated browser sessions, test microphones, actual encryption/decryption and decoded audio. `RTCPeerConnection` deliberately throws, and every calling socket must use Buddy's origin/port. Checks consent, encrypted packet size, mute/unmute and microphone release on hang-up.
- `tests/test_people_audio.py`: no audio before acceptance, fixed owner/client identity, duplicate-tab protection, public-only key exchange, disconnect cleanup and absence of audio/private-key database columns.
- `tests/test_people_calls.py`: call state, clock-independent remaining duration, automatic endings distinguished from Decline, membership revocation and legacy signaling validation.
- `tests/people_live_messages_browser.mjs`: real writes and WebSocket delivery with snapshot polling stalled, consecutive Enter sends and retained input focus.

Browser tests use explicitly synthetic accounts and fake microphones. Their cleanup removes test accounts, sessions, messages, rooms and call metadata. Tests on the deployment host do not establish audio quality or hardware/browser policy on a particular remote user's device.
