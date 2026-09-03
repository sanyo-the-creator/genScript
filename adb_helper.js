const { execSync } = require('child_process');
const path = require('path');
const switchers = require('./adb_app_switchers');
const tiktokStudio = require('./tiktok_studio');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function runAdb(args) {
  try {
    const stdout = execSync(`adb ${args}`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] });
    return stdout.trim();
  } catch (err) {
    console.error(`❌ ADB command failed: adb ${args}`, err.message);
    throw err;
  }
}

function getDevices() {
  const output = runAdb('devices');
  const lines = output.split('\n').slice(1);
  return lines
    .map(line => {
      const parts = line.split('\t');
      if (parts.length === 2) {
        return { id: parts[0], status: parts[1] };
      }
      return null;
    })
    .filter(Boolean);
}

function getProfiles() {
  try {
    const output = runAdb('shell pm list users');
    // Output format:
    // Users:
    //  UserInfo{0:Owner:c13} running
    //  UserInfo{10:Work:10}
    const profiles = [];
    const lines = output.split('\n');
    lines.forEach(line => {
      const match = line.match(/UserInfo\{(\d+):([^:]+):/);
      if (match) {
        profiles.push({
          id: parseInt(match[1]),
          name: match[2],
          isRunning: line.includes('running')
        });
      }
    });
    return profiles;
  } catch (err) {
    console.error('Could not list GrapheneOS users:', err.message);
    return [];
  }
}

// Switch the device to a GrapheneOS user profile. The switch itself takes
// several seconds, so it is skipped when that profile is ALREADY in the
// foreground — a 50-post batch normally runs on one profile, where this saves
// the switch plus its settle wait on every post after the first.
function currentUserId() {
  try {
    const out = runAdb('shell am get-current-user');
    const m = String(out).trim().match(/(\d+)\s*$/);
    return m ? parseInt(m[1], 10) : null;
  } catch { return null; }
}
function switchProfile(userId) {
  if (currentUserId() === Number(userId)) {
    console.log(`✓ Already on GrapheneOS profile ${userId} — no switch needed.`);
    return false;
  }
  console.log(`🔄 Switching to GrapheneOS profile ${userId}...`);
  runAdb(`shell am switch-user ${userId}`);
  return true;
}

function getScreenSize() {
  const output = runAdb('shell wm size');
  // Output: Physical size: 1080x2400
  const match = output.match(/(\d+)x(\d+)/);
  if (match) {
    return { width: parseInt(match[1]), height: parseInt(match[2]) };
  }
  return { width: 1080, height: 1920 }; // Fallback
}

function tap(x, y) {
  runAdb(`shell input tap ${x} ${y}`);
}

function swipe(x1, y1, x2, y2, duration = 300) {
  runAdb(`shell input swipe ${x1} ${y1} ${x2} ${y2} ${duration}`);
}

function inputText(text) {
  // ADB shell input text requires spaces to be replaced with %s
  const escapedText = text.replace(/ /g, '%s').replace(/['"]/g, '');
  runAdb(`shell input text "${escapedText}"`);
}

function scanFile(remotePath, userId) {
  console.log(`Scan file: ${remotePath}`);
  try {
    runAdb(`shell am broadcast -a android.intent.action.MEDIA_SCANNER_SCAN_FILE -d file://${remotePath}`);
  } catch (err) {
    // Ignore scan broadcast failures
  }
}

// Push a local media file into a specific GrapheneOS user's shared storage.
//
// A plain `adb push /storage/emulated/<userId>/...` fails with "Permission
// denied" for any secondary user, because the adb shell always runs in user 0's
// storage context and cannot touch another user's isolated /sdcard. The only
// no-root way to land a file in a secondary user's gallery is to go through that
// user's MediaStore via the `content` command with `--user <userId>`:
//   1. `content insert` creates an (empty) MediaStore row under DCIM/Camera,
//   2. `content write` streams the local file's bytes into that row.
// The app running on that user (e.g. TikTok Studio) then sees the file in its
// gallery picker. Returns the content:// URI so it can be deleted afterwards.
function pushMediaAsUser(localFile, userId, displayName) {
  const ext = path.extname(localFile).toLowerCase();
  const isVideo = /\.(mp4|mov|webm|mkv)$/i.test(ext);
  const uriBase = isVideo
    ? 'content://media/external/video/media'
    : 'content://media/external/images/media';
  let mime = 'image/jpeg';
  if (isVideo) mime = 'video/mp4';
  else if (ext === '.png') mime = 'image/png';
  else if (ext === '.webp') mime = 'image/webp';

  // 1. Create the MediaStore row (unique display name so we can find its id back).
  runAdb(
    `shell content insert --user ${userId} --uri ${uriBase} ` +
      `--bind _display_name:s:${displayName} ` +
      `--bind mime_type:s:${mime} ` +
      `--bind relative_path:s:DCIM/Camera`
  );

  // 2. Resolve the _id of the row we just inserted by querying for its name.
  //    The whole `content query ...` must be one adb-shell argument (wrapped in
  //    escaped double quotes) so the host shell doesn't strip the --where quoting
  //    before adb ever sees it.
  const query = runAdb(
    `shell "content query --user ${userId} --uri ${uriBase} ` +
      `--projection _id:_display_name --where \\"_display_name='${displayName}'\\""`
  );
  let id = null;
  query.split('\n').forEach((line) => {
    const m = line.match(/_id=(\d+)/);
    if (m) id = m[1]; // last match wins (newest row for this name)
  });
  if (!id) {
    throw new Error(`Could not resolve MediaStore id for ${displayName} on user ${userId}`);
  }
  const fileUri = `${uriBase}/${id}`;

  // 3. Stream the local file bytes into the row. Must go through execSync with
  //    a real stdin redirect (runAdb captures stdio and can't pipe a file).
  execSync(`adb shell content write --user ${userId} --uri ${fileUri} < "${localFile}"`, {
    stdio: ['pipe', 'pipe', 'ignore']
  });

  return fileUri;
}

function deleteMediaUri(fileUri, userId) {
  try {
    runAdb(`shell content delete --user ${userId} --uri ${fileUri}`);
  } catch (e) {
    // ignore cleanup failures
  }
}

async function executeSteps(steps, accountIndex, textToInput, scheduledTime) {
  const size = getScreenSize();
  console.log(`📱 Device screen size: ${size.width}x${size.height}`);

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    console.log(`👉 Running step: ${step.desc}`);

    if (step.action === 'branch') {
      const branchStep = step.accounts[accountIndex - 1] || step.accounts[0];
      console.log(`👉 Branching to step: ${branchStep.desc}`);
      const rx = Math.round(branchStep.x * size.width);
      const ry = Math.round(branchStep.y * size.height);
      tap(rx, ry);
      await sleep(branchStep.delay || 1000);
    } else if (step.action === 'tap') {
      const rx = Math.round(step.x * size.width);
      const ry = Math.round(step.y * size.height);
      tap(rx, ry);
      await sleep(step.delay || 1000);
    } else if (step.action === 'swipe') {
      const rx1 = Math.round(step.x1 * size.width);
      const ry1 = Math.round(step.y1 * size.height);
      const rx2 = Math.round(step.x2 * size.width);
      const ry2 = Math.round(step.y2 * size.height);
      swipe(rx1, ry1, rx2, ry2, step.duration || 300);
      await sleep(step.delay || 1000);
    } else if (step.action === 'input_text') {
      if (textToInput) {
        inputText(textToInput);
      }
      await sleep(step.delay || 1000);
    } else if (step.action === 'tap_random_saved_sound') {
      // 50% chance to scroll down randomly to mix up the list of saved sounds
      const shouldScroll = Math.random() > 0.5;
      if (shouldScroll) {
        const swipeDist = Math.floor(Math.random() * 500) + 200; // 200px to 700px swipe
        console.log(`📜 Scrolling favorites list by ${swipeDist}px to randomize sounds...`);
        swipe(Math.round(size.width * 0.5), Math.round(size.height * 0.7), Math.round(size.width * 0.5), Math.round(size.height * 0.7 - swipeDist), 400);
        await sleep(1500);
      }
      // Tap at a random Y coordinate within the list (typically between 40% and 75% of screen height)
      const randomYRatio = 0.40 + (Math.random() * 0.35);
      const rx = Math.round(size.width * 0.5);
      const ry = Math.round(size.height * randomYRatio);
      console.log(`🎯 Tapping random Y coordinate: ${ry} (Ratio: ${randomYRatio.toFixed(2)})`);
      tap(rx, ry);
      await sleep(step.delay || 1000);
    } else if (step.action === 'input_schedule_time') {
      if (scheduledTime) {
        const date = new Date(scheduledTime);
        const hours = String(date.getHours()).padStart(2, '0');
        const minutes = String(date.getMinutes()).padStart(2, '0');
        console.log(`⏰ Inputting schedule time: ${hours}:${minutes}`);
        
        // Toggle Keyboard Mode in TimePickerDialog (usually bottom-left keyboard icon)
        const kbx = Math.round(0.20 * size.width);
        const kby = Math.round(0.62 * size.height);
        tap(kbx, kby);
        await sleep(1500);

        // Input hour
        inputText(hours);
        await sleep(1000);
        
        // Tab keyevent (61) to focus minutes input
        runAdb("shell input keyevent 61");
        await sleep(1000);
        
        // Input minute
        inputText(minutes);
        await sleep(1000);
      }
    }
  }
}

async function postMediaToApp(platform, accountIndex, mediaFiles, caption, userId, scheduledTime, phoneWall) {
  // TikTok photo slideshows use the dedicated, fully reverse-engineered flow in
  // tiktok_studio.js (media picker order, random favourite sound, schedule wheel).
  const isSlideshow = mediaFiles.length > 1 || /\.(png|jpg|jpeg|webp)$/i.test(mediaFiles[0] || '');
  if (platform === 'tiktok' && isSlideshow) {
    // Only pay the switch settle time when a switch actually happened.
    if (switchProfile(userId)) await sleep(5000);
    return tiktokStudio.scheduleSlideshow({
      userId,
      mediaFiles,
      caption,
      phoneWall,       // phone-local wall clock (preferred; correct across timezones)
      scheduledTime,   // fallback only
      debugShots: false, // screenshots add ~0.3s each; off in production for speed
    });
  }

  const appConfig = switchers[platform];
  if (!appConfig) {
    throw new Error(`Platform config for "${platform}" not found.`);
  }

  // 1. Ensure profile is active
  if (switchProfile(userId)) await sleep(5000); // Wait for profile switch transition

  // 2. Push media files into user `userId`'s DCIM/Camera via MediaStore.
  //    (Direct `adb push` to /storage/emulated/<userId>/ is denied for any
  //     secondary user — see pushMediaAsUser for the why.)
  const remoteUris = [];
  for (let i = 0; i < mediaFiles.length; i++) {
    const localFile = mediaFiles[i];
    const ext = path.extname(localFile);
    // Unique name so ordering is preserved and MediaStore lookups are unambiguous.
    const remoteName = `upload_temp_${Date.now()}_${String(i).padStart(3, '0')}${ext}`;

    console.log(`📤 Pushing ${localFile} → user ${userId} DCIM/Camera/${remoteName}...`);
    const uri = pushMediaAsUser(localFile, userId, remoteName);
    remoteUris.push(uri);
  }
  await sleep(3000); // Wait for MediaStore to index

  try {
    // 3. Launch App
    console.log(`🚀 Launching ${appConfig.packageName}...`);
    runAdb(`shell am start -n ${appConfig.packageName}/${appConfig.activityName}`);
    await sleep(6000); // Wait for app load

    // 4. Switch to Account index
    if (accountIndex && accountIndex > 0) {
      console.log(`👤 Switching account to sub-account index ${accountIndex}...`);
      await executeSteps(appConfig.switchSteps, accountIndex, null);
    } else {
      console.log(`👤 Skipping account switching (using currently active account).`);
    }

    // 5. Post media
    console.log(`📝 Posting media to ${platform}...`);
    await executeSteps(appConfig.postSteps, accountIndex, caption, scheduledTime);
    console.log(`✅ Posting sequence finished.`);
  } finally {
    // 6. Cleanup remote files to save GrapheneOS storage space
    console.log(`🧹 Cleaning up media files from phone...`);
    remoteUris.forEach(uri => deleteMediaUri(uri, userId));
  }
}

module.exports = {
  getDevices,
  getProfiles,
  switchProfile,
  getScreenSize,
  postMediaToApp,
  pushMediaAsUser,
  deleteMediaUri
};
