# DashPal BLE protocol v1 (app copy)

The authoritative copy is the firmware's `docs/BLE_PROTOCOL.md` (repo `deployment-stack`). This file repeats it for readers of the app. The codec is `protocol.ts`; the golden vectors are `__fixtures__/ble_vectors.json`, byte-identical to the firmware's `tests/ble_vectors.json`.

Codec rules both sides share (firmware doc §3): a receiver checks, in this order, length < 2 (`short`), a type that is not of this direction (`type`), a version other than 1 (`version`), a length below the type's v1 length (`short`); it accepts longer frames and ignores trailing and reserved bytes; a sender never sends more than 20 bytes. A TX read returns an empty value: it exists so an iOS read can start pairing during setup.

## Protocol

### 1 GATT and advertising
Base UUID `d5a1xxxx-7b3e-4c8a-9f21-0c6e5a7d2b10`.

| Item | xxxx | Properties | Access |
|---|---|---|---|
| DashPal service | `0001` | advertised while the pairing window is closed | — |
| Pairing service (empty) | `00f0` | advertised instead of `0001` while the window is open | — |
| `INFO` | `0002` | read | open |
| `IDENTIFY` | `0003` | write with response | open. From an authorized link: always accepted. From any other link: accepted only while the pairing window is open and no other link holds the setup claim (or while this link holds it); else ATT error `0x80`. A `0x01` write from a link that is not authorized takes (or restarts) the setup claim |
| `TX` | `0004` | notify + read | `READ_ENC` + `NOTIFY_INDICATE_ENC` (an unencrypted access gets Insufficient Encryption, which makes iOS pair); an encrypted read is refused (ATT `0x80`) unless the link is authorized (a new bond accepted on the link holding the setup claim is authorized at once); subscribing needs encryption only, but frames go to authorized links only |
| `RX` | `0005` | write + write-without-response | `WRITE_ENC`; frames dropped unless authorized |

Plus the Device Information Service `0x180A` (manufacturer "DashPal", model "DP-1", firmware revision "dms-core x.y"), not advertised. Attribute table stable; if it ever changes, send Service Changed to bonded peers.

**INFO payload** (read): `[ver u8 = 1][proto_min u8][proto_max u8][fw_major u8][fw_minor u8][mac 6 bytes, identity address, MSB first][peer_bonded u8 (this link's peer is in the bond store)][bond_count u8][flags u8: bit0 pairing_open, bit1 setup_busy (another link holds the setup claim: a phone is setting this dashcam up)]` = 14 bytes. `dashcam_id` (phone side) = lowercase hex of `mac` (12 chars). The name suffix `XXXX` = the last 2 bytes of that same MAC, uppercase hex.

Advertising: ADV = flags + one 128-bit UUID (`0001` or `00f0`); scan response = complete local name `DashPal-XXXX`. Public identity address, no peripheral privacy. Intervals: 20 ms for 30 s after boot, after a disconnect and while the pairing window is open; then 152.5 ms; 1022.5 ms while one phone is connected; stop at 2 links. Default TX power.

Security: NimBLE peripheral, max 2 connections, LESC Just Works (`NO_IO`, bonding, SC, no MITM, legacy pairing off), key distribution ENC|ID both ways, `CONFIG_BT_NIMBLE_NVS_PERSIST=y`, `MAX_BONDS=4`. **Authorized** = `sec_state.encrypted ∧ sec_state.bonded ∧ peer_id_addr ∈ ble_store_util_bonded_peers`.

- **Setup claim.** While the pairing window is open, the first link that is not authorized and writes `IDENTIFY 0x01` holds the setup claim. While another link holds it, `IDENTIFY` from any other link that is not authorized gets ATT `0x80` and makes no sound. Writing `0x01` again restarts the claim. The claim ends when that link disconnects or becomes authorized, when its bond is accepted, 180 s after its last `IDENTIFY 0x01`, or whenever the window is opened or explicitly closed. A window that times out does not end a claim that is already held.
- **A new bond is accepted only on the link holding the setup claim.** Any other new bond (outside the window, with no identify, or on another link) → `ble_gap_unpair` + terminate.
- **The first accepted bond closes the pairing window**, so one window admits one phone.
- A link that is not authorized is terminated: if it holds the setup claim, when the claim expires (180 s after its last `IDENTIFY 0x01`); when the claim ends because the window is opened again or explicitly closed, the link falls under the two rules below, counted from when it connected; otherwise, if it connected while the window was open, 30 s after connecting (time to identify), as long as the window stays open; otherwise 2 s after connecting.
- Repeat pairing (phone lost its keys) only on the link holding the setup claim (old bond deleted, pairing retried); otherwise ignored, so the phone fails encryption and shows "needs pairing again".
- Bond store full: a pairing request from a link without the setup claim is refused before any key is exchanged; for the claiming link, the oldest bonded peer that is not connected is deleted first.
- Every accepted bond plays `SOUND_PAIRED` + LED pattern from the firmware itself (the owner hears any new pairing).
- Just Works authenticates neither side: a relay present during the owner's setup is not detected.
- **Pairing window**: zero bonds → open for the first 10 minutes after each boot; otherwise 120 s after 5 presses of the BOOT button, 10 presses (every bond deleted first), the `ble pair` console command, or COMMAND 3 ("Add another phone"). Opening it (again) ends any setup claim. It closes when the time is up or at the first accepted bond. While open, the pairing service UUID is advertised.

After encryption: request interval 15–30 ms, latency 0, supervision 6 s; MTU 247; log what was negotiated.

### 2 Framing
Little-endian. Byte 0 = type, byte 1 = protocol version `1`. A receiver **accepts a frame whose length is ≥ the v1 length for its type and ignores trailing bytes**; shorter frames, unknown types and other versions are dropped and counted (never crash). Max 20 bytes.

**Dashcam → phone (TX notify)**

| Type | Name | Fields after `[type][ver]` | Len |
|---|---|---|---|
| `0x01` | HELLO | `boot_id u32, next_seq u32, oldest_seq u32, uptime_ms u32` | 18 |
| `0x02` | STATUS | `uptime_ms u32, state u8, flags u8, fps_x10 u8, temp_c i8, bond_count u8` | 11 |
| `0x03` | EVENT | `seq u32, t_ms u32, dur_ds u16, ev u8, tier_aud u8, detail u8, value_x10 i16, rsv u8` | 18 |
| `0x04` | ALERT | `alert_id u16, sound u8, tier u8, level u8, mode u8, route u8, rsv u8, uptime_ms u32` | 14 |
| `0x05` | ALERT_STOP | `alert_id u16, reason u8` | 5 |
| `0x06` | ALERT_FALLBACK | `alert_id u16, cause u8` | 5 |
| `0x07` | TIME_ECHO | `req_id u16, uptime_ms u32` | 8 |
| `0x08` | PAIRED | `bond_count u8` | 3 |

- `boot_id`: a **random non-zero u32 drawn every boot** (`bootloader_random_enable()` + `esp_fill_random`, or after the RF is up). Never a counter (NVS is erased by merged-image flashes). The phone only compares for equality.
- `seq`: per-boot event counter from 0. `next_seq` = the seq the next new event gets. `oldest_seq` = the oldest seq still in the replay ring.
- `t_ms` = dashcam uptime (ms) when the rule fired; `dur_ds` = `(t − t_start)` in 0.1 s (saturating at 65535); condition start = `t_ms − dur_ds·100`. u32 uptime wraps after 49.7 days: the phone treats a decrease of `uptime_ms` within one boot as a new offset epoch (documented, not otherwise handled).
- `ev` = engine event id in the frozen `dms/alerts.py` `EventType` order: 0 MICROSLEEP, 1 SLEEP, 2 UNRESPONSIVE, 3 LONG_GLANCE, 4 VATS, 5 FACE_LOST, 6 FATIGUE_DROWSY, 7 FATIGUE_SEVERE, 8 FATIGUE_EARLY, 9 PHONE_PATTERN, 10 REPEATED_DISTRACTION, 11 MONITORING_LIMITED, 12 GLANCE, 13 LOOK_BACK, 14 YAWN, 15 HEAD_NOD, 16 REPEAT_MICROSLEEP, 17 GAZE_CONCENTRATION, 18 NO_SCANNING, 19 FATIGUE_LEVEL, 20 CALIBRATED, 21 CALIBRATION_LOW_CONFIDENCE, 22 CALIBRATION_RESET, 23 CAMERA_BUMP, 24 DRIVER_CHANGE, 25 RECENTRED, 26 POSTURE_CHANGE, 27 ZONE_LEARNED, 28 NUISANCE_TAG, 29 MONITORING_RESTORED, 30 PHONE_HANDHELD, 31 CRITICAL_STAND_DOWN (tier 0, log only: a critical alert stopped because the face had been gone 30 s with no known speed ≥ 10 km/h; `value` = seconds gone). Append-only. Unknown ids are stored as `UNKNOWN_<n>` and never scored.
- `tier_aud`: bits 0–1 tier, bit 7 `audible` (engine "would sound"; independent of mute/shadow/route).
- `detail`: 0 none; UNRESPONSIVE: 1 `no_return` (D4, after a distraction warning), 2 `eyes_closed`, 3 `no_return_critical` (F3, after a critical); MICROSLEEP: 4 `nod`; CRITICAL_STAND_DOWN: 5 `face_gone`. Any other detail is sent as 0.
- `value_x10` = engine `value` × 10, clamped to i16.
- STATUS `state`: 0 booting, 1 no_face, 2 calibrating, 3 monitoring, 4 limited, 5 paused (overheat / preview / bench / HIL / camcheck / replay), 6 camera_error (runtime camera failure). `flags`: bit0 muted (mute or shadow), bit1 pairing_open, bit2 time_synced, bit3 calibrated (detection ready), bit4 primary (this link is the dashcam's primary link, §3.4), bit5 buzzer_active, bit6 live (a blink was detected in the last 60 s). Sent after HELLO, on any state/flags change, and periodically — every 2 s (1 s while an alert is active) **only to links whose last STATE arrived < 10 s ago**; other links get STATUS on change only.
- ALERT `sound` (computed from the `alert_sounds` state, identical in typed and tiers mode): 1 glance (warning from LONG_GLANCE / VATS, SOUND_DISTRACTION or SOUND_WARNING), 2 drowsy (SOUND_DROWSY or the fatigue override), 3 wake (SOUND_CRITICAL / SOUND_DROWSY_CRITICAL), 4 phone (UNSAFE(_ONCE) or a chime caused by PHONE_PATTERN / PHONE_HANDHELD), 5 chime (any other audible advisory one-shot), 6 no_face (the no-face alert: the driver's face out of view while the phone reports the car moving; FACE_LOST; buzzer SOUND_NO_FACE, two beeps every 5 s; continuous, tier 2, never joined by the buzzer, silent on both outputs while no phone is live). A phone treats a `sound` it does not know as the chime (level 1, every 2.5 s): an app that predates sound 6 plays the no-face alert as a continuous chime and, because it is continuous, holds other audio ducked and mutes its own event tones for as long as the face is out of view. The app and the firmware ship together; there is no capability negotiation. **Never routed, gated or sent as ALERT**: READY, SYSTEM, BOOT, TAG_ACK, TEST, TEST_TYPES, IDENTIFY, PAIRED and COMMAND-6 test sounds. `tier` 1–3; `level` 0–3 (critical escalation step, else 0); `mode` 0 once, 1 continuous; `route` 1 = routed to this phone (ACK required within the firmware's `device.ble_ack_ms`, default 750), 0 = informational (visual + haptic only, never ACK, never play sound). `alert_id` per boot, wraps, never 0.
- **Alert identity**: a change of `tier` or `sound` ends the alert (ALERT_STOP reason 1) and starts a new `alert_id`; a `level` change re-sends ALERT with the same id and needs no new ACK.
- ALERT_STOP `reason`: 0 cleared (including paused / sleep / overheat), 1 superseded, 2 muted. ALERT_FALLBACK `cause`: 1 no ACK in time, 2 phone said cannot (at any time, also after a confirm), 3 lease expired, 4 escalation (buzzer joined; the phone keeps playing).

**Phone → dashcam (RX write)**

| Type | Name | Fields after `[type][ver]` | Len |
|---|---|---|---|
| `0x81` | STATE | `flags u8, ttl_ds u8, speed_cms u16, local_min u16, boot_id u32, ack_seq u32` | 16 |
| `0x82` | ACK | `boot_id u32, ack_seq u32` | 10 |
| `0x83` | ALERT_ACK | `alert_id u16, outcome u8` | 5 |
| `0x84` | TIME_PING | `req_id u16, epoch_ms u64` | 12 |
| `0x85` | RESUME | `boot_id u32, next_seq u32` | 10 |
| `0x86` | COMMAND | `op u8, arg u8` | 4 |

- STATE (lease + context): `flags` bit0 `can_play`, bit1 `buzzer_too`, bit2 `drive_active`, bit3 `speed_valid`; `ttl_ds` lease lifetime in 0.1 s (phone sends 30; dashcam clamps 10..50); `speed_cms` cm/s (meaningful only with `speed_valid`); `local_min` 0–1439 or `0xFFFF`; `boot_id` + `ack_seq`: cumulative ack for that boot (all `seq < ack_seq` persisted; `0` = nothing yet). The dashcam ignores an ack whose `boot_id` is not its current one. The dashcam uses acks for diagnostics only (`ble` status "unacked"); replay happens only on RESUME.
- ALERT_ACK `outcome`: 1 playing, 0 cannot. The phone answers every `route=1` ALERT immediately with 1 or 0, and sends 0 later if playback fails or is interrupted.
- TIME_PING: phone epoch ms at send; the dashcam answers TIME_ECHO and stores `epoch_offset = epoch_ms − uptime_ms` (good to ± one-way latency) for its own logs (`events.jsonl` `unix`, `trip.json`).
- RESUME: the phone's per-boot cursor. Dashcam: if `boot_id` = current boot and `next_seq ≤ dashcam next_seq` → send HELLO + STATUS, then every ring event with `seq ≥ next_seq`; otherwise → HELLO + STATUS, then the whole ring from `oldest_seq`.
- COMMAND `op`: 1 identify (identify melody + LED ~3 s), 2 recalibrate, 3 open the pairing window (authorized links only; 120 s, until one new phone pairs; ends any setup claim), 4 forget me (delete this peer's bond, then disconnect), 5 pair confirm (phone UX; plays nothing extra if the bond chime already played in the last 10 s, else the paired chime; sends PAIRED), 6 test sound (`arg` = sound 1–5 on the buzzer), **7 hello** (dashcam answers HELLO + STATUS and, if an alert is active, ALERT with `route=0`).
- IDENTIFY characteristic: 1 byte `0x01` = identify (other values are ignored, but a refused link gets ATT `0x80` whatever the value).

### 3 Connection sequence (phone)
1. Connect: iOS pending connect by peripheral identifier; Android `connect(id,{autoconnect:true})` re-issued after **every** disconnect (ble-manager closes the GATT on disconnect), or a direct connect after a foreground scan.
2. Android `requestMTU(247)`; both `retrieveServices`.
3. **Read INFO** (open). Outside the setup flow: if `peer_bonded = 0` → `needs_repair`, disconnect, no auto-reconnect, and never touch an encrypted attribute (that would raise an OS pairing dialog, possibly mid-drive).
4. `startNotification(TX)`, then **COMMAND 7 hello** (always; CCCDs of bonded peers are restored silently, so subscription alone does not produce HELLO).
5. On HELLO: TIME_PING ×3 (100 ms apart); **RESUME after the 3 echoes or 500 ms**, whichever first; then STATE every second (event-driven, §7.3). With the app in the Android background JS timers are paused, so STATE goes out once per drive row instead: a row sends it unless one went out in the last 300 ms (the row's timer pump or a dashcam frame just sent it). Rows come once a second, location or not, and a row closes up to 1.5 s after its second, so rows come up to about 2.5 s apart and STATEs at most about 2.8 s apart, inside the 3 s TTL.
6. TIME_PING ×3 again every 10 min (triggered from the link tick).

Setup (a new phone, while the window is open; `setup.ts`): on Android, if the OS still holds a bond for the dashcam (reflashed, wiped by 10 presses, or it forgot the phone), remove it **before the identify**: removing a bond drops the link, and with it the setup claim, so a bond made after it would be on a new connection without the claim and would be refused. For any dashcam but the paired one, remove it before connecting. For the paired dashcam, whose bond may still work, connect keeping it and read INFO: if `peer_bonded = 0`, disconnect, remove it and connect again; otherwise keep it (the link encrypts with it, `IDENTIFY` from the authorized link is accepted and `createBond` finds the bond already made), so a setup answered No, failed or cancelled leaves a working pairing as it was. Then, with INFO read: if `flags` bit 1 is set, another phone is setting the dashcam up: do not write `IDENTIFY`. Otherwise `IDENTIFY 0x01`; ask the driver whether the dashcam beeps; bond on **the same connection** within 180 s of the identify; then COMMAND 7, COMMAND 5, PAIRED. If the connection drops between the identify and the bond, reconnect and write `IDENTIFY 0x01` again before bonding.

### 4 Routing (dashcam, `ble_link`)
- **Primary link** (at most one): among authorized links with a fresh STATE, prefer one whose STATE has `drive_active`; otherwise the current primary keeps it until its STATE lapses; otherwise the most recent. STATUS bit4 tells each link whether it is primary. Only the primary can hold the audio lease.
- `lease_valid(now)` = primary authorized link ∧ last STATE `can_play` ∧ `now − last_state_rx ≤ ttl`.
- **Continuous sound starts** (an episode runs from `cont ≠ NONE` to `cont = NONE`):
  - tier 3: buzzer plays **at once and throughout**; ALERT `route=1` to the lease holder if any (phone plays too; ACK accepted, but the buzzer never gates for tier 3).
  - tier 1/2 with `lease_valid` and the episode not yet fallen back: ALERT `route=1`, the continuous gate closes (buzzer silent), deadline = time the ALERT was handed to NimBLE successfully + `ble_ack_ms`. ACK(1) → confirmed. ACK(0), deadline passed, lease lapsed, primary changed or disconnect → **fallback** (gate opens; the players kept ticking so the rhythm continues in phase); ALERT_FALLBACK sent if connected. Once an episode has fallen back, every later alert in that episode stays on the buzzer (sent with `route=0`).
  - A confirmed tier-2 alert still active after **3 s** → buzzer joins (ALERT_FALLBACK cause 4; phone keeps playing), except the no-face alert (sound 6), which is never joined, also when it supersedes a glance warning the buzzer had joined: the buzzer goes silent with the supersede.
  - `buzzer_too` → buzzer always plays as well (ALERT still `route=1`).
  - no lease → buzzer at once; ALERT `route=0` if connected.
- **The no-face alert (sound 6) is phone-only.** The dashcam raises it only while the phone reports the car moving (STATE `speed_valid`, 10 km/h or more). It is routed as above while a phone is **live**: the primary link, its last STATE within its TTL (`ttl_ds`), whether or not it can play. A fallback while the phone is live (ALERT_ACK(0), a missed deadline, the lease lost to a STATE without `can_play`) hands it to the buzzer as usual. When no phone is live (a disconnect, or the primary's STATE older than its TTL) the dashcam ends it with ALERT_STOP(0) to every remaining synced link and holds the buzzer silent: no ALERT_FALLBACK, in the same call for a disconnect, within one tick for a lapsed TTL. A sound-6 episode that starts with no live phone sends no ALERT and stays silent. When a phone is live again while the engine still requests it, a new alert starts with normal routing.
- **One-shots** (advisory chimes): with `lease_valid`, the one-shot is **not enqueued in alerts.c**; `ble_link` holds it and, on ACK(0) / deadline / lease loss / disconnect, calls `alerts_play_once(sound)` at that moment. alerts.c must allow a one-shot to play while a *gated* continuous is active. Without a lease → `alerts_play_once` at once.
- Sound clears → ALERT_STOP(0). Entering a paused state, overheat, preview, deep sleep, HIL reset → every path that stops sound goes through one wrapper `app_sound_set(...)` that informs `ble_link` (ALERT_STOP 0). `mute` → ALERT_STOP(2) and no further ALERT while muted; `unmute` while a sound is active = a new alert start (normal routing).
- On a (re)connect while an alert is active: after HELLO/STATUS send ALERT with `route=0` (visual only; never re-routed).
- ALERT_ACKs are accepted only from the link the alert was routed to.

### 5 Alert handling (phone)
- `route=1` → ALERT_ACK(1) **before** starting playback if the phone can play now, else ALERT_ACK(0); then play (or haptic + visual only). `route=0` → haptic + visual only, no ACK, no sound. A new `route=1` ALERT handled more than `LATE_ALERT_MS` (750 ms, the dashcam's default ACK deadline) after its `uptime_ms` by the boot's offset (the JS thread woke past the dashcam's ACK deadline, so the buzzer already has it) → ALERT_ACK(0), haptic + visual only; a level step of an alert already in the table is never treated as late.
- Continuous: repeat until ALERT_STOP, ALERT_FALLBACK cause 1–3, disconnect, or **3 s with no frame from the dashcam**. Cause 4 → keep playing.
- Repeat cadence (start-to-start, never faster than an item finishes): glance 2.5 s, drowsy 4 s, no face 5 s, wake 1.5 s at level 0 → 1.0 s at level ≥ 2. One-shots once.
- The no-face alert (sound 6) plays the glance tone with the words "Driver not visible", spoken on the first play only and not when another no-face alert ended in the last 60 s. Its plays release the audio session (music comes back between them), and it does not make the phone's own event tones vibration and visual only.
- A new HELLO with a different `boot_id`, or a connect, clears the phone's alert table.

### 6 Events and timeline (phone)
- Per `(dashcam_id, boot_id)` the phone keeps (table `dashcam_boots`): best offset (`epoch − uptime`) with its RTT, and `floor_seq` (= max(floor, HELLO.oldest_seq), raised past the newest pruned event by the prune below; it never falls). Offset starts from HELLO (`receive_time − uptime_ms`, discarded if the HELLO arrived > 1 s after the connect/hello request) and is replaced by any TIME_PING sample with a lower RTT (`(send + recv)/2 − echo.uptime_ms`). The HELLO sample's error can be its whole round trip and a ping's at most half of its own, so the HELLO sample ranks as twice its round trip: a ping over the same link always replaces it, which keeps the error within RTT/2.
- Persist each EVENT with `INSERT OR IGNORE` on `(dashcam_id, boot_id, seq)`, assigning `id` = a fresh lowercase v4 UUID at first insert; an EVENT whose seq is below the boot's stored `floor_seq` is not stored (every seq there is stored, gone from the dashcam, pruned or given up by the prune). Then ACK: cursor = lowest seq ≥ `floor_seq` not yet stored (gaps below `oldest_seq` are permanent and advance the floor). RESUME uses the same cursor.
- An EVENT that arrives while no drive is open (a drive is open from the Start Drive tap until its finalize has finished, the drive-end catch-up included) is persisted and acknowledged like any other, since the cursor needs every seq, but stored with `ignored = 1`, decided as the frame arrives. The first copy's flag stands: a replayed copy is a duplicate and changes nothing. A drive claims only events with `ignored = 0` whose condition start (`offset + t_ms − dur_ds·100`) lies inside it, so an event that started before the drive and arrives during it (a replay after a mid-drive reconnect) stays unclaimed. Unclaimed events, ignored ones included, are deleted 7 days after receipt: the prune first raises each such boot's `floor_seq` past the newest of them, so the cursor never moves back (a link up for over a week on one boot stays synced, and no RESUME asks for a pruned seq) and a re-sent pruned seq, a whole-ring replay included, is not stored again. A gap below a pruned event is given up with it: seqs rise with time on one boot, so whatever fills it started over 7 days ago and no drive could claim it.
- A HELLO whose `boot_id` matches a stored boot but whose `next_seq` is below the stored max seq + 1 → treat as a new boot (should not happen with random ids; defence in depth).
- Wall times are **derived when needed** (facts at finalize, timeline display) from `t_ms`, `dur_ds` and the best offset at that moment; columns `at_ms`/`started_at_ms` are only a cache.

### 7 Context (dashcam)
`ble_link_context(now)`: `speed_kmh` = the last STATE speed if that STATE had `speed_valid` and is ≤ 10 s old; a STATE with `speed_valid = 0` makes it NaN at once. Only the primary link's STATE counts. `local_min` = last received value advanced by elapsed uptime (NaN if never received). `yaw_rate_dps` = NaN always. Fed into `ctx` before `dms_frontend_process`. Phone sets `speed_valid` only while recording and when the latest drive row is ≤ 2 s old, `gnssValid`, `speed ≥ 0`, and `0 ≤ speedAcc ≤ 2 m/s`.
