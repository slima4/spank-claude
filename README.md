# spank-claude

> Your MacBook has an accelerometer. Claude Code has plugins. You have feelings.
> Now they can finally meet.

Slap your MacBook (or the desk it sits on) and Claude Code feels it: a face pops
up above the prompt, the laptop yelps back in Japanese, and a little counter
keeps score of how your day is going. Optionally, Claude itself gets the
message — and a hard enough slap stops it mid-turn.

<p>
  <img src="plugin/assets/faces/level_1.png" width="96" alt="level 1">
  <img src="plugin/assets/faces/level_2.png" width="96" alt="level 2">
  <img src="plugin/assets/faces/level_3.png" width="96" alt="level 3">
  <img src="plugin/assets/faces/level_4.png" width="96" alt="level 4">
  <img src="plugin/assets/faces/level_5.png" width="96" alt="level 5">
</p>

Inspired by the [Spank Phone](https://apps.apple.com/us/app/spank-phone-slap-your-phone/id6761312196)
iOS app, minus the phone, plus an AI that can take a hint.

## The pain scale

| Level | Hit          | She says    | What probably happened             |
| ----- | ------------ | ----------- | ---------------------------------- |
| 1     | 0.05–0.1 g   | んっ！      | A tap. Passive-aggressive at most. |
| 2     | 0.1–0.25 g   | あっ！      | The tests failed again.            |
| 3     | 0.25–0.5 g   | いたっ！    | Claude "simplified" your code.     |
| 4     | 0.5–1 g      | きゃっ！    | Claude deleted the tests to make them pass. |
| 5     | 1 g and up   | あぁっ…！   | Production.                        |

## What you need

- An Apple Silicon MacBook with the motion sensor: M1 Pro / Max or newer. The
  plain 2020 M1 13" reportedly has no readable sensor. A Mac mini will feel
  nothing, no matter how hard you hit it. Please don't test this.
- macOS 27. It reads the sensor without `sudo` there; older releases may want
  root (untested).
- Xcode Command Line Tools (`xcode-select --install`), for `swiftc`.
- Claude Code with plugin function hooks (built and tested on 2.1.288; that API
  is early access and may move).

## Install

```sh
git clone https://github.com/slima4/spank-claude
cd spank-claude
make install                      # builds slapd, puts it in plugin/bin
claude --plugin-dir "$PWD/plugin"
```

The status line under the prompt says `spank: armed`. Go on. Slap it.

To load it in every session without the flag, add the folder to the `env` block
of `~/.claude/settings.json`:

```json
{
  "env": {
    "CLAUDE_CODE_PLUGIN_DIRS": "/absolute/path/to/spank-claude/plugin"
  }
}
```

## Commands

| Command              | Does                                                        |
| -------------------- | ----------------------------------------------------------- |
| `/slaps`             | Your score: this session, all time, and the last hit.       |
| `/slaps mute`        | Silences her. The faces still judge you.                    |
| `/slaps unmute`      | She's back.                                                 |
| `/slaps claude on`   | Slaps reach Claude, and level 4+ stops its running turn.    |
| `/slaps claude off`  | Claude stays blissfully unaware (the default).              |
| `/slaps image`       | Checks whether your terminal can show real pictures.        |

### Claude mode

With `/slaps claude on`, every slap becomes a quiet note in the conversation:
*"The user just physically slapped their laptop 2 times (strongest hit level 3
of 5). Take it as nonverbal frustration…"* Claude reads it on its next step,
acknowledges it, and reconsiders what it was doing. Slaps while it's idle are saved up and delivered
as one note with your next message, so it gets the whole story at once.

A level 4+ slap while Claude is working stops the turn on the spot. Fair
warning: a shell command Claude already started keeps running in the
background; the slap stops Claude, not the command.

## Faces and terminals

Faces are drawn as colored half-block characters, so they show up in any
truecolor terminal (Warp, iTerm2, Ghostty, …), pixel-art style, in the
biggest size that fits above your prompt.

Real, full-resolution pictures need a terminal with kitty graphics Unicode
placeholders, which today means Ghostty or kitty. Run `/slaps image` to see what
yours can do. Warp and Terminal.app currently can't (not our fault, we checked).

## Tuning

If typing counts as slapping, or the desk doesn't register, look at the raw
numbers first:

```sh
make raw      # prints the live shake, 10 times a second; ctrl-c to stop
```

Type, knock on the desk, slap the palm rest, and pick a threshold between your
typing and your knock. Then pass it to `slapd` in `plugin/hooks/register.tsx`
(`argv: [..., '--threshold', '0.08']`) and save; the plugin reloads.

## How it works

```
 MacBook IMU (AppleSPUHIDDevice, ~1 kHz)
      │  IOKit HID reports, x/y/z in 1/65536 g
      ▼
 slapd (Swift) ── removes gravity, finds the peak, grades it 1–5
      │  {"type":"slap","peak":0.42,"level":3} on stdout
      ▼
 spank plugin (Claude Code hooks)
      ├─ status line + toast
      ├─ face above the prompt (Raster cells, 3 s)
      ├─ voice clip per level
      └─ optional: note to Claude / stop its turn
```

## Development

```sh
make install                       # rebuild slapd into the plugin
make faces                         # rebuild face cells from assets/faces/*.png
claude plugin validate plugin      # what the engine will load
claude plugin test plugin          # the tests
```

Swap in your own faces (`assets/faces/level_<1-5>.png`) and voices
(`plugin/assets/voices/level_<1-5>.mp3`), then update the captions in
`plugin/hooks/register.tsx`.

## Safety notes

- It's a laptop, not a punching bag. AppleCare does not cover "it was for a
  plugin."
- Level 5 is reachable with a firm palm. You don't need to prove anything.
- The sensor reading comes from the community's reverse-engineering work in
  [olvvier/apple-silicon-accelerometer](https://github.com/olvvier/apple-silicon-accelerometer)
  and [taigrr/apple-silicon-accelerometer](https://github.com/taigrr/apple-silicon-accelerometer).
  Not affiliated with Apple, Anthropic, or the Spank Phone app.
