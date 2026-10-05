# spank-claude

> Your MacBook has an accelerometer. Claude Code has plugins. You have feelings.
> Now they can finally meet.

Slap your MacBook (or the desk it sits on) and Claude Code feels it: a face pops
up above the prompt, the laptop yelps back in Japanese, and a little counter
keeps score of how your day is going. Optionally, Claude itself gets the
message — and a hard enough slap stops it mid-turn.

<p>
  <img src="plugin/assets/faces/sakura/level_1.png" width="96" alt="Sakura, level 1">
  <img src="plugin/assets/faces/sakura/level_2.png" width="96" alt="Sakura, level 2">
  <img src="plugin/assets/faces/sakura/level_3.png" width="96" alt="Sakura, level 3">
  <img src="plugin/assets/faces/sakura/level_4.png" width="96" alt="Sakura, level 4">
  <img src="plugin/assets/faces/sakura/level_5.png" width="96" alt="Sakura, level 5">
  <br>
  <img src="plugin/assets/faces/natsu/level_1.png" width="96" alt="Natsu, level 1">
  <img src="plugin/assets/faces/natsu/level_2.png" width="96" alt="Natsu, level 2">
  <img src="plugin/assets/faces/natsu/level_3.png" width="96" alt="Natsu, level 3">
  <img src="plugin/assets/faces/natsu/level_4.png" width="96" alt="Natsu, level 4">
  <img src="plugin/assets/faces/natsu/level_5.png" width="96" alt="Natsu, level 5">
  <br>
  <img src="plugin/assets/faces/aki/level_1.png" width="96" alt="Aki, level 1">
  <img src="plugin/assets/faces/aki/level_2.png" width="96" alt="Aki, level 2">
  <img src="plugin/assets/faces/aki/level_3.png" width="96" alt="Aki, level 3">
  <img src="plugin/assets/faces/aki/level_4.png" width="96" alt="Aki, level 4">
  <img src="plugin/assets/faces/aki/level_5.png" width="96" alt="Aki, level 5">
</p>

## The pain scale

| Level | Hit (at 0.05 g) | Sakura says | Natsu says  | Aki says    | What probably happened             |
| ----- | --------------- | ----------- | ----------- | ----------- | ---------------------------------- |
| 1     | 0.050–0.106 g   | んっ！      | えっ！      | ひゃっ！    | A tap. Passive-aggressive at most. |
| 2     | 0.106–0.224 g   | あっ！      | うっ！      | あれっ！    | The tests failed again.            |
| 3     | 0.224–0.473 g   | いたっ！    | いてっ！    | いたぁ！    | Claude "simplified" your code.     |
| 4     | 0.473–1 g       | きゃっ！    | やっ！      | いやっ！    | Claude deleted the tests to make them pass. |
| 5     | 1 g and up      | あぁっ…！   | うわぁっ！  | きゃあっ！  | Production.                        |

The g ranges are for the default sensitivity, 0.05 g. The scale moves with
yours (`/slaps calibrate`, or "Slap sensitivity" in `/config`): level 1 starts
at your sensitivity, level 5 at 1 g, and the levels between are spread evenly.
At 0.15 g, for example, they start at about 0.15, 0.24, 0.39, 0.62 and 1 g.

Two exceptions. Below 0.05 g the scale stays as it is at 0.05 g: softer taps
count, as level 1, but a moderate slap doesn't turn into a level 4. Above
0.25 g, level 5 starts at 4 times your sensitivity instead of 1 g, so the
levels don't bunch up.

### Combos

Keep slapping, less than a second apart, and every tap counts, however soft:
each is one level above the one before, or its own level if it hit harder, and
the level never drops until you pause. Five soft taps make her scream. A
harder slap cuts her off with its own yelp; one at the same level does too,
but stays quiet if her last yelp is under 0.4 s old, so drumming doesn't
stutter. The face says how many came in a row, and a combo puts up one toast
as it starts and one as it ends, saying how far it got. The score (`/slaps`,
the status line) still keeps what the sensor read.

Taps can come as fast as about 7 a second. A hard slap leaves the laptop
ringing, so the next tap counts once that has died down, usually within a
fraction of a second.

## What you need

- An Apple Silicon MacBook with the motion sensor: M1 Pro / Max or newer. The
  plain 2020 M1 13" reportedly has no readable sensor. A Mac mini will feel
  nothing, no matter how hard you hit it. Please don't test this.
- macOS 27. It reads the sensor without `sudo` there; older releases may want
  root (untested).
- Xcode Command Line Tools (`xcode-select --install`). The plugin builds its
  little sensor reader from Swift source on first run, so nothing precompiled
  ships in the repo.
- Claude Code with plugin function hooks (built and tested on 2.1.288; that API
  is early access and may move).

## Install

Two commands, no cloning:

```sh
claude plugin marketplace add slima4/spank-claude
claude plugin install spank@spank-claude
```

(or the same from inside Claude Code: `/plugin marketplace add slima4/spank-claude`,
then `/plugin install spank@spank-claude`.)

Start Claude Code. The first session builds the sensor reader (the status line
says `spank: building the sensor reader`, about 20 seconds), then shows
`spank: armed (0.05g)`. Go on. Slap it.

Updates: `claude plugin update spank@spank-claude`, then restart Claude Code.
Each new version builds its sensor reader again on its first start.
Uninstall: `claude plugin uninstall spank@spank-claude`.

## Commands

| Command              | Does                                                        |
| -------------------- | ----------------------------------------------------------- |
| `/slaps`             | Your score: this session, all time, and the last hit.       |
| `/slaps who`         | Lists the face series; the current one is marked.           |
| `/slaps who natsu`   | Natsu gets slapped now (any series name works).             |
| `/slaps calibrate`   | Type 6 s (no Enter), knock 3 times; it picks the sensitivity. |
| `/slaps mute`        | Silences her. The faces still judge you.                    |
| `/slaps unmute`      | She's back.                                                 |
| `/slaps claude on`   | Slaps reach Claude; a level 4+ slap or combo stops its turn. |
| `/slaps claude off`  | Claude stays blissfully unaware (the default).              |
| `/slaps image`       | Checks whether your terminal can show real pictures.        |

### Claude mode

With `/slaps claude on`, every slap becomes a quiet note in the conversation:
*"The user just physically slapped their laptop 2 times (accelerometer;
strongest hit level 3 of 5, 0.31g). Take it as nonverbal frustration…"*
Claude reads it on its next step, acknowledges it, and reconsiders what it was
doing. Slaps that keep coming are told as one note once you pause, or 4
seconds after the first, whichever comes sooner. Slaps while it's idle are
saved up and delivered as one note with your next message, so it gets the
whole story at once.

A level 4+ slap while Claude is working stops the turn on the spot (the level
is a setting). So does a combo that builds up to it and lasts at least half a
second (so one slap that bounces doesn't), unless one of its slaps was a
level 1 graze (so the steady shaking of a bumpy train doesn't). Fair
warning: a shell command Claude already started keeps running in the
background; the slap stops Claude, not the command.

### Several sessions

Only the Claude Code session you used last reacts to a slap (the one you
last typed a prompt or a `/slaps` command in). One laptop, one victim.

## Face series

Each face series is one character: five faces, one per level, and a voice.
Switch with `/slaps who <series>` (`/slaps who` lists them), or under
"Face series" in `/config`.

| Series   | Voice    | Face                                                          |
| -------- | -------- | ------------------------------------------------------------- |
| `sakura` | `sakura` | <img src="plugin/assets/faces/sakura/level_1.png" width="48" alt="Sakura"> |
| `natsu`  | `natsu`  | <img src="plugin/assets/faces/natsu/level_1.png" width="48" alt="Natsu">   |
| `aki`    | `aki`    | <img src="plugin/assets/faces/aki/level_1.png" width="48" alt="Aki">       |

## Faces and terminals

Faces are drawn as colored half-block characters, so they show up in any
truecolor terminal (Warp, iTerm2, Ghostty, …), pixel-art style, in the
biggest size that fits above your prompt.

Real, full-resolution pictures need a terminal with kitty graphics Unicode
placeholders, which today means Ghostty or kitty. Run `/slaps image` to see what
yours can do. Warp and Terminal.app currently can't (not our fault, we checked).

## Settings

Open `/config` in Claude Code (or `/plugin configure spank@spank-claude`):

| Setting                 | Default | What it does                                              |
| ----------------------- | ------- | --------------------------------------------------------- |
| Slap sensitivity (g)    | 0.05    | Smallest shake that counts, and where level 1 starts. Typing counts? Raise it. |
| Level that stops Claude | 4       | With `/slaps claude on`, this level or harder stops a turn. |
| Face series             | sakura  | `sakura`, `natsu` or `aki`: whose face pops up and voice yelps. |
| Face size               | large   | `large`, `medium`, `small`, or `off`.                     |
| Voice volume            | 1       | 0 is silent, up to 4 for open-plan offices.               |

Changes apply right away. Not sure what sensitivity to pick? Run
`/slaps calibrate`: type anything for 6 seconds (don't press Enter, or Claude
gets it), then knock on the desk 3 times, and it sets the sensitivity between
the two for you. The 6 seconds start at your first key and the knocking at
your first knock, so take your time reading; it waits up to 30 seconds for
each. The status line then shows it, e.g. `spank: armed (0.077g)`.

## How it works

```
 MacBook IMU (AppleSPUHIDDevice, ~1 kHz)
      │  IOKit HID reports, x/y/z in 1/65536 g
      ▼
 slapd (Swift) ── removes gravity, finds the peak
      │  {"type":"slap","ts":…,"peak":0.42} on stdout
      ▼
 spank plugin (Claude Code hooks) ── grades it 1–5 for your sensitivity
      ├─ status line + toast
      ├─ face above the prompt (Raster cells, 3 s)
      ├─ voice clip per level
      └─ optional: note to Claude / stop its turn
```

## Development

Run straight from a clone (uninstall the marketplace copy first, or you get
two of her):

```sh
git clone https://github.com/slima4/spank-claude && cd spank-claude
claude --plugin-dir "$PWD/plugin"

make slapd                         # build the sensor reader by hand
make raw                           # watch the live shake
make faces                         # rebuild face cells from assets/faces/<series>/*.png
claude plugin validate .           # the marketplace and the plugin
claude plugin test plugin          # the tests
```

Installed copies are kept per version, so bump `version` in
`plugin/.claude-plugin/plugin.json` when you ship a change.

To add a face series, say `hana`:

1. Put its faces in `assets/faces/hana/level_<1-5>.png` (square, on white).
2. Add `"hana"` to the `face_series` options in `plugin/.claude-plugin/plugin.json`.
3. Run `make faces`. It draws the cells into `plugin/hooks/faces.ts`, writes the
   256px pictures to `plugin/assets/faces/hana/`, and warns if step 2 is missing.
4. In `plugin/hooks/series.ts`, add `hana` to `SERIES`. It can borrow an
   existing voice (`voice: 'sakura'`), or get its own: clips in
   `plugin/assets/voices/hana/level_<1-5>.mp3` and their captions in `VOICES`.

## License

[MIT](LICENSE). Slap responsibly.

## Safety notes

- It's a laptop, not a punching bag. AppleCare does not cover "it was for a
  plugin."
- Level 5 is reachable with a firm palm. You don't need to prove anything.
- The sensor reading comes from the community's reverse-engineering work in
  [olvvier/apple-silicon-accelerometer](https://github.com/olvvier/apple-silicon-accelerometer)
  and [taigrr/apple-silicon-accelerometer](https://github.com/taigrr/apple-silicon-accelerometer).
