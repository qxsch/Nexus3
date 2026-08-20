# Installing NEXUS·3 on macOS

The macOS builds are **not signed with an Apple Developer ID**, so macOS will refuse to open the app
the first time. That is expected and it takes about fifteen seconds to get past. Everything below is
a one-time step.

---

## 1. Pick the right file

Two disk images are attached to every [release](https://github.com/qxsch/Nexus3/releases):

| Your Mac | Download |
| --- | --- |
| Apple Silicon (M1, M2, M3, M4 …) | `NEXUS-3-<version>-macos-arm64.dmg` |
| Intel | `NEXUS-3-<version>-macos-x64.dmg` |

Not sure which you have? Apple menu &rarr; **About This Mac**. If it says **Chip: Apple M…** take the
`arm64` file, if it says **Processor: Intel…** take the `x64` one.

Apple Silicon Macs can run the Intel build through Rosetta, but do not: this is a real-time audio
app, and the native `arm64` build has lower latency and lower CPU use.

---

## 2. Install

1. Double-click the downloaded `.dmg`. A window opens with the **NEXUS-3** app and a shortcut to
   **Applications**.
2. Drag **NEXUS-3** onto **Applications**.
3. Eject the disk image (drag it to the Bin, or click the eject arrow in the Finder sidebar).

---

## 3. First launch, the part that needs a nudge

Double-clicking the app now shows something like *"Apple could not verify NEXUS-3 is free of malware"*
or *"NEXUS-3 cannot be opened because the developer cannot be verified"*.

### macOS 15 Sequoia and newer

1. Double-click **NEXUS-3** in Applications. The warning appears. Click **Done**.
2. Open **System Settings** &rarr; **Privacy & Security**.
3. Scroll down to the Security section. There is a line saying *"NEXUS-3 was blocked to protect your
   Mac"* with an **Open Anyway** button. Click it.
4. Confirm with Touch ID or your password, then click **Open Anyway** once more.

The app starts, and from then on it opens normally by double-clicking.

> On macOS 15 and later, Control-clicking the app and choosing Open no longer works. Apple removed
> that shortcut, so the Privacy & Security route is the only way through the graphical interface.

### macOS 14 Sonoma and older

1. **Control-click** (or right-click) **NEXUS-3** in Applications.
2. Choose **Open**.
3. In the dialog that appears, click **Open** again.

---

## 4. If it says the app is "damaged and can't be opened"

That message almost always means the quarantine flag, not a corrupted download. macOS attaches the
flag to anything downloaded from the internet, and for an unsigned app it sometimes reports it this
way instead of offering the Open Anyway button.

Open **Terminal** and run:

```bash
xattr -dr com.apple.quarantine /Applications/NEXUS-3.app
```

Then open the app normally. If it still fails, download the disk image again and check you took the
build that matches your chip.

---

## 5. What the app asks for on first run

* **Microphone access.** Only if you press **Name devices** in the top bar. macOS hides the *names*
  of audio output devices until an app has been granted a media permission, so this is the only way
  to show "External Headphones" instead of a random identifier. Nothing is recorded, the microphone
  stream is opened and released immediately. Decline it and everything still works, the devices just
  appear unnamed.
* **A music folder.** The library defaults to your **Music** folder. Change it under
  **File** &rarr; **Change music folder**. The index and settings are written to
  `~/Library/Application Support/NEXUS-3/`.

Headphone cueing to a second output device works on macOS in this app, because it bundles Chromium
rather than using Safari's engine.

---

## 6. Updating

There is no auto-updater on purpose. Download the newer `.dmg` and drag it over the old app,
confirming the replacement. Your library index, settings and window layout live outside the app in
`~/Library/Application Support/NEXUS-3/` and are kept.

The Gatekeeper prompt appears again for each new version, since each download is quarantined
separately.

---

## 7. Uninstalling

1. Drag **NEXUS-3** from Applications to the Bin.
2. Optionally remove the settings and the library index:

```bash
rm -rf ~/Library/Application\ Support/NEXUS-3
```

Your music files are never touched. Tracks archived from Jamendo stay in whatever library folder you
chose.

---

## Why is there a warning at all?

Signing an app so macOS accepts it silently requires membership of the Apple Developer Program, which
costs 99 USD a year. This is a free, open-source project, so the builds go out unsigned. The warning
means "Apple has not been paid to vouch for this developer", not "this software is known to be
harmful".

If you would rather not take that on trust, you have two options:

* Build it yourself on your own Mac, which produces an identical app with no warning:

  ```bash
  git clone https://github.com/qxsch/Nexus3.git
  cd Nexus3
  pwsh ./build.ps1 -Os macos -Arch arm64
  ```

  This needs [PowerShell](https://github.com/PowerShell/PowerShell) and Node 22.5 or newer. The
  package lands in `build-artifact/`.

* Skip the app and run the browser version, which needs no installation at all:

  ```bash
  npm start
  ```

  Then open <http://localhost:5173> in Chrome or Edge. See the [README](README.md) for the details.
