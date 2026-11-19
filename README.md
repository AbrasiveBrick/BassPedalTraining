# Bass Pedal Trainer

A browser app for practising kick / bass drum pedal technique, with a **single** or a **double pedal**, on a piezo kick pad such as the **Millenium MPS-850 8" mesh kick pad**.

The pad goes into a USB audio interface. The app finds every stroke in the audio signal and scores your timing against a sample-accurate metronome.

**Live app:** https://abrasivebrick.github.io/BassPedalTraining/

## Features

- **Hit detection from the raw pad signal** (AudioWorklet), with tuning for gain, threshold, retrigger mask and ringing suppression. A **noise check** sets the threshold above the noise your resting foot makes.
- **Latency calibration**: play along with 16 clicks and the app removes the audio round-trip delay from every score.
- **Timing scores**: each stroke is graded *perfect* (±10 ms), *good* (±25 ms), *ok* or *missed*, and extra hits are counted too. The app shows whether you're rushing or dragging, how even you are (timing spread), and, with a double pedal, a **right vs left foot** comparison of timing and volume.
- **Pattern drills** on a scrolling note lane:
  - Single pedal: quarters, 8ths, triplets, heel-toe / slide doubles, single-foot gallop, 16ths.
  - Double pedal: 16ths, 16th triplets, gallop, reverse gallop, 1-beat bursts, 32nd bursts, groups of 3 and 5, RRLL doubles, paradiddle, left-lead 16ths.
- **Practice modes**:
  - Fixed tempo.
  - Endurance (timed).
  - **Speed builder**: the tempo goes up by *N* BPM each time you pass a step (*X* bars) at the target accuracy, and drops back after two failed steps.
- **Progress history**: every run is saved in your browser and charted (max clean BPM and accuracy over time). You can export and import it as JSON.
- **Keyboard stand-in**: <kbd>Space</kbd>, <kbd>F</kbd> or <kbd>J</kbd> act as the pad, so you can try everything without hardware.

## Hardware hookup

1. Connect the kick pad's jack output to an **instrument (Hi-Z) or line input** of your audio interface (Focusrite Scarlett, Behringer UMC, etc.). Use a **mono 6.3 mm (TS) jack cable**.
2. Set the interface's **input gain low** and turn **phantom power (48 V) off**. Piezo pads put out strong spikes, so it's best if the interface's clip LED barely flickers on hard strokes.
3. If your interface has a "direct monitor" switch, turn it off so you don't hear the thump of the pad.
4. Open the app in Chrome, Edge or Firefox, go to **Setup** and pick the interface. Click **Connect** and allow microphone access. It's your interface input, and nothing is recorded or uploaded.

> The pad can't tell which beater hit it. In double-pedal mode the R/L labels show which foot *should* play each note, and the per-foot stats compare those notes. If one foot is weaker or late, its average timing and volume show it.

## Tuning the trigger

| Symptom | Fix |
|---|---|
| One stroke counts twice | Raise **Ringing suppression** (longer decay), then **Retrigger mask** |
| Soft strokes are missed | Lower **Threshold** or raise **Gain** |
| Soft strokes right after loud ones are missed | Lower **Ringing suppression** |
| Triggers when the foot rests on the pedal | Run **Noise check**, or raise **Threshold** |
| Fast doubles merge into one | Lower **Retrigger mask**: it must be shorter than your fastest stroke gap (16ths at 220 BPM = 68 ms) |

Then run **Calibrate latency** once per interface or buffer-size setting. A small interface buffer (64–128 samples) gives the snappiest feel.

## Development

```bash
npm install
npm run dev      # http://localhost:5173
npm test         # unit tests (detector, patterns, scoring, speed builder, calibration)
npm run build    # production build in dist/
```

Stack: Vite + TypeScript, no runtime dependencies. The main code:

- `src/audio/onsetDetector.ts`: pure hit-detection algorithm, shared by the AudioWorklet (`onset-processor.ts`) and the tests.
- `src/audio/metronome.ts`: pre-rendered click buffers scheduled on the AudioContext clock (lookahead scheduler).
- `src/engine/`: patterns, scoring, speed builder, session orchestration, calibration.
- `src/ui/`: Setup, Practice (note lane and offset chart) and History views.

Every push to `main` runs the tests and deploys to GitHub Pages via `.github/workflows/deploy.yml`.
