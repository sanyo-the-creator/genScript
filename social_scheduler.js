const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const puppeteer = require('puppeteer-core');
const adbHelper = require('./adb_helper');
const tiktokStudio = require('./tiktok_studio');

// Natural sort so slideshow pages order 1,2,...,9,10 instead of 1,10,2,...
const natSort = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });

const SCHEDULE_FILE = path.join(__dirname, 'graphene_schedule.json');
const PROFILES_FILE = path.join(__dirname, 'graphene_profiles.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function loadSchedule() {
  try { return JSON.parse(fs.readFileSync(SCHEDULE_FILE, 'utf8')); } catch { return []; }
}

function saveSchedule(data) {
  fs.writeFileSync(SCHEDULE_FILE, JSON.stringify(data, null, 2));
}

// Removes tasks from the genScript queue (and their local extracted media copy).
// This ONLY touches genScript's own files — it does NOT delete anything already
// scheduled on the device in TikTok Studio. Returns how many were removed.
function deleteTasks(ids) {
  const set = new Set(ids || []);
  const schedule = loadSchedule();
  const remaining = schedule.filter((t) => !set.has(t.id));
  const removed = schedule.filter((t) => set.has(t.id));
  const mediaRoot = path.join(__dirname, 'public', 'media_library');
  removed.forEach((t) => {
    // Only clean up copies we made under public/media_library/, never anything else.
    if (t.mediaPath && t.mediaPath.startsWith(mediaRoot)) {
      try { fs.rmSync(t.mediaPath, { recursive: true, force: true }); } catch {}
    }
  });
  saveSchedule(remaining);
  return removed.length;
}

function loadProfiles() {
  try { return JSON.parse(fs.readFileSync(PROFILES_FILE, 'utf8')); } catch { return []; }
}

function saveProfiles(data) {
  fs.writeFileSync(PROFILES_FILE, JSON.stringify(data, null, 2));
}

// Helper to automate YouTube Studio upload via desktop browser Puppeteer
async function uploadToYouTubeStudio(port, mediaPath, title, caption, scheduledTime) {
  console.log(`🎬 Connecting to Chrome on port ${port} for YouTube Studio upload...`);
  let browser;
  try {
    browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${port}`, defaultViewport: null });
  } catch (err) {
    throw new Error(`Could not connect to debug Chrome on port ${port}. Is it running?`);
  }

  const pages = await browser.pages();
  const page = pages.find((p) => p.url().includes('studio.youtube.com')) || pages[0];
  if (!page) {
    browser.disconnect();
    throw new Error('No YouTube Studio or browser tab found.');
  }

  await page.bringToFront();
  await page.goto('https://studio.youtube.com', { waitUntil: 'networkidle2' }).catch(() => {});
  await sleep(2000);

  // 1. Click Create -> Upload
  const createBtn = await page.waitForSelector('ytcp-button', { timeout: 30000 });
  await createBtn.click();
  await sleep(1000);

  const uploadItem = await page.waitForSelector('#text-item-0', { timeout: 10000 });
  await uploadItem.click();
  await sleep(1000);

  // 2. Upload file
  const fileInput = await page.waitForSelector('input[type="file"]', { timeout: 10000 });
  await fileInput.uploadFile(mediaPath);
  console.log('   • Video uploaded to browser, waiting for editor form...');

  // 3. Fill details
  const titleBox = await page.waitForSelector('#textbox', { timeout: 120000 });
  await sleep(1500);

  // Clear prefilled filename title and set custom title
  await page.evaluate((el, text) => {
    el.textContent = text;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, titleBox, title);

  // Description
  const descriptionText = caption || '';
  await page.evaluate((text) => {
    const boxes = Array.from(document.querySelectorAll('#textbox')).filter((b) => b.offsetParent !== null);
    if (boxes[1]) {
      boxes[1].textContent = text;
      boxes[1].dispatchEvent(new Event('input', { bubbles: true }));
    }
  }, descriptionText);

  // Not made for kids
  const notForKids = await page.waitForSelector('tp-yt-paper-radio-button[name="VIDEO_MADE_FOR_KIDS_NOT_MFK"]', { timeout: 10000 });
  await notForKids.click();
  await sleep(500);

  // Next Next Next to Visibility
  for (let i = 0; i < 4; i++) {
    const nextBtn = await page.$('#next-button');
    if (nextBtn) {
      await nextBtn.click();
      await sleep(1500);
    }
  }

  // Schedule option
  const scheduleToggle = await page.waitForSelector('#second-container', { timeout: 10000 });
  await scheduleToggle.click();
  await sleep(1000);

  // Parse scheduling date & time from the scheduledTime ISO string
  const dateObj = new Date(scheduledTime);
  const dateLabel = dateObj.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }); // e.g. "Aug 8, 2026"
  const hours = dateObj.getHours();
  const minutes = dateObj.getMinutes();
  const ampm = hours >= 12 ? 'PM' : 'AM';
  const displayHours = hours % 12 || 12;
  const displayMinutes = minutes.toString().padStart(2, '0');
  const timeLabel = `${displayHours}:${displayMinutes} ${ampm}`;

  // Set date picker
  const dateTrigger = await page.waitForSelector('#datepicker-trigger', { timeout: 10000 });
  await dateTrigger.click();
  await sleep(800);
  const dateInput = await page.waitForSelector('ytcp-date-picker input', { timeout: 5000 });
  await page.evaluate((el) => el.select(), dateInput);
  await dateInput.type(dateLabel);
  await page.keyboard.press('Enter');
  await sleep(800);

  // Set time picker
  const timeInput = await page.evaluateHandle(() => {
    const picker = document.querySelector('ytcp-datetime-picker');
    return picker ? Array.from(picker.querySelectorAll('input')).find((i) => /(AM|PM)/i.test(i.value || '')) : null;
  });
  if (timeInput) {
    await timeInput.click();
    await page.evaluate((el) => el.select(), timeInput);
    await timeInput.type(timeLabel);
    await page.keyboard.press('Enter');
    await sleep(800);
  }

  // Click final Schedule button
  const doneBtn = await page.waitForSelector('#done-button', { timeout: 10000 });
  await doneBtn.click();
  await sleep(4000);

  console.log(`✅ Video successfully scheduled on YouTube Studio for ${dateLabel} ${timeLabel}`);
  browser.disconnect();
}

async function processNextScheduledItem() {
  const schedule = loadSchedule();
  const profiles = loadProfiles();
  const now = new Date();

  // Find next pending item that is due
  const itemIndex = schedule.findIndex(item => item.status === 'pending' && new Date(item.scheduledTime) <= now);
  if (itemIndex === -1) return;

  const item = schedule[itemIndex];
  item.status = 'running';
  saveSchedule(schedule);

  console.log(`\n🚀 Processing scheduled task #${item.id} (Scheduled at: ${item.scheduledTime})`);
  await executeTask(item, schedule, profiles);
}

async function processItemImmediately(taskId) {
  const schedule = loadSchedule();
  const profiles = loadProfiles();
  const item = schedule.find(t => t.id === taskId);
  if (!item) throw new Error('Task not found');

  item.status = 'running';
  saveSchedule(schedule);

  console.log(`\n🚀 Triggering task #${item.id} IMMEDIATELY`);
  await executeTask(item, schedule, profiles);
}

async function executeTask(item, schedule, profiles) {
  const profile = profiles.find(p => p.id === item.profileId);
  if (!profile) {
    console.error(`✗ GrapheneOS Profile "${item.profileId}" not found in config.`);
    item.status = 'failed';
    saveSchedule(schedule);
    return;
  }

  const subAccount = profile.subAccounts.find(sa => sa.id === item.subAccountId);
  if (!subAccount) {
    console.error(`✗ Sub-account "${item.subAccountId}" not found under profile "${profile.name}".`);
    item.status = 'failed';
    saveSchedule(schedule);
    return;
  }

  item.results = item.results || {};

  // Execute sequentially for each selected platform
  for (const platform of item.platforms) {
    if (item.results[platform] && item.results[platform].status === 'success') {
      continue; // Skip already successfully posted platforms
    }

    console.log(`📱 Posting to ${platform} for ${profile.name} (${subAccount.name})...`);
    item.results[platform] = { status: 'running' };
    saveSchedule(schedule);

    try {
      if (platform === 'youtube') {
        const ytConfig = subAccount.accounts.youtube;
        if (!ytConfig || !ytConfig.port) {
          throw new Error('Missing YouTube port or configuration.');
        }
        const title = item.caption ? item.caption.split('\n')[0].slice(0, 100) : 'Video upload';
        await uploadToYouTubeStudio(ytConfig.port, item.mediaPath, title, item.caption, item.scheduledTime);
      } else {
        // TikTok, Instagram, Threads, X
        const appConfig = subAccount.accounts[platform];
        if (!appConfig || !appConfig.accountIndex) {
          throw new Error(`Missing ${platform} account config/index.`);
        }

        let mediaFiles = [item.mediaPath];

        // Handle ZIP slideshow or directory of images
        if (item.mediaType === 'slideshow') {
          const isDir = fs.statSync(item.mediaPath).isDirectory();
          if (isDir) {
            const files = fs.readdirSync(item.mediaPath);
            mediaFiles = files
              .filter(f => /\.(png|jpg|jpeg|webp)$/i.test(f))
              .sort(natSort)
              .map(f => path.join(item.mediaPath, f));
          } else {
            const zipPath = item.mediaPath;
            const unzipDir = path.join(__dirname, 'public', `unzipped_${item.id}`);
            if (!fs.existsSync(unzipDir)) {
              fs.mkdirSync(unzipDir, { recursive: true });
            }
            console.log(`📦 Unzipping ${zipPath} to ${unzipDir}...`);
            // Use native macOS unzip utility to avoid library dependencies
            execSync(`unzip -o "${zipPath}" -d "${unzipDir}"`);
            
            // Get ordered images recursively
            const getFilesRecursively = (dir) => {
              let results = [];
              if (!fs.existsSync(dir)) return results;
              const list = fs.readdirSync(dir);
              list.forEach(file => {
                if (file === '__MACOSX' || file.startsWith('.')) return;
                const filePath = path.join(dir, file);
                const stat = fs.statSync(filePath);
                if (stat && stat.isDirectory()) {
                  results = results.concat(getFilesRecursively(filePath));
                } else {
                  results.push(filePath);
                }
              });
              return results;
            };

            const allFiles = getFilesRecursively(unzipDir);
            mediaFiles = allFiles
              .filter(f => /\.(png|jpg|jpeg|webp)$/i.test(f))
              .sort(natSort) // Sort alphabetically to maintain page order
              ;
          }

          if (mediaFiles.length === 0) {
            throw new Error('No images found in extracted slideshow ZIP.');
          }
        }

        await adbHelper.postMediaToApp(platform, appConfig.accountIndex, mediaFiles, item.caption, profile.grapheneUserId, item.scheduledTime, item.phoneWall);
      }

      item.results[platform] = { status: 'success', postedAt: new Date().toISOString() };
    } catch (err) {
      // A Stop press aborts mid-flow — leave the task 'pending' so it can be
      // re-run later, and bubble up so the sequential runner halts.
      if (err.message === 'STOP_REQUESTED') {
        console.log(`⏹️  Stopped during ${platform} for task #${item.id}.`);
        item.results[platform] = { status: 'pending' };
        item.status = 'pending';
        saveSchedule(schedule);
        throw err;
      }
      console.error(`✗ Failed to post to ${platform}:`, err.message);
      item.results[platform] = { status: 'failed', error: err.message };
    }

    saveSchedule(schedule);
  }

  // Check if all selected platforms completed successfully
  const allSucceeded = item.platforms.every(p => item.results[p] && item.results[p].status === 'success');
  item.status = allSucceeded ? 'success' : 'failed';
  saveSchedule(schedule);

  console.log(`🏁 Task #${item.id} processing completed. Status: ${item.status}`);
}

// Start a background loop to tick the scheduler every 60 seconds
let intervalId = null;
function startSchedulerLoop() {
  if (intervalId) return;
  console.log('⏰ Starting background Post Scheduler loop (runs every 60 seconds)...');
  intervalId = setInterval(() => {
    processNextScheduledItem().catch(err => {
      console.error('Error in background scheduler tick:', err);
    });
  }, 60000);
}

function findPostsInExtractedDir(rootDir, defaultCaption = '') {
  const isImage = (f) => /\.(png|jpg|jpeg|webp)$/i.test(f);
  const isVideo = (f) => /\.(mp4|mov|webm|mkv)$/i.test(f);
  const isCaptionFile = (f) => /\.(txt|md|caption|text)$/i.test(f);

  const posts = [];

  function scanDir(currentDir) {
    let entries = [];
    try {
      entries = fs.readdirSync(currentDir).filter(f => !f.startsWith('.') && f !== '__MACOSX');
    } catch {
      return;
    }

    const images = entries.filter(f => {
      try { return !fs.statSync(path.join(currentDir, f)).isDirectory() && isImage(f); } catch { return false; }
    }).sort(natSort);

    const videos = entries.filter(f => {
      try { return !fs.statSync(path.join(currentDir, f)).isDirectory() && isVideo(f); } catch { return false; }
    }).sort(natSort);

    const captionFileName = entries.find(f => {
      try { return !fs.statSync(path.join(currentDir, f)).isDirectory() && isCaptionFile(f); } catch { return false; }
    });

    const subdirs = entries.filter(f => {
      try { return fs.statSync(path.join(currentDir, f)).isDirectory(); } catch { return false; }
    }).sort(natSort);

    // If this directory directly contains images or videos, treat it as a post
    if (images.length > 0 || videos.length > 0) {
      let caption = defaultCaption || '';
      if (captionFileName) {
        try {
          caption = fs.readFileSync(path.join(currentDir, captionFileName), 'utf8').trim();
        } catch {}
      } else if (!caption) {
        const folderName = path.basename(currentDir);
        if (folderName && folderName !== path.basename(rootDir) && !folderName.startsWith('temp_extract_')) {
          caption = folderName.replace(/[-_]+/g, ' ').trim();
        }
      }

      posts.push({
        dirPath: currentDir,
        name: path.basename(currentDir) || 'Slideshow',
        images,
        videos,
        captionFileName,
        caption
      });
    }

    // Continue scanning subdirectories
    for (const sub of subdirs) {
      scanDir(path.join(currentDir, sub));
    }
  }

  scanDir(rootDir);
  return posts;
}

function importZipArchive(profileId, subAccountId, platforms, zipPath, fallbackCaption, startDateLabel) {
  const schedule = loadSchedule();
  
  // Create a temp folder for extraction
  const tempExtractDir = path.join(__dirname, 'public', `temp_extract_${Date.now()}`);
  if (!fs.existsSync(tempExtractDir)) {
    fs.mkdirSync(tempExtractDir, { recursive: true });
  }

  // Extract ZIP
  try {
    execSync(`unzip -o "${zipPath}" -d "${tempExtractDir}"`);
  } catch (err) {
    console.error('Failed to unzip archive:', err.message);
    throw new Error('Failed to extract ZIP archive: ' + err.message);
  }

  // Discover all post folders recursively
  const discoveredPosts = findPostsInExtractedDir(tempExtractDir, fallbackCaption);

  if (discoveredPosts.length === 0) {
    // Cleanup temp extract folder
    try { execSync(`rm -rf "${tempExtractDir}"`); } catch {}
    try { fs.unlinkSync(zipPath); } catch {}
    throw new Error('No images or slideshow folders found in the extracted ZIP archive.');
  }

  const targetSlots = tiktokStudio.nextPhoneSlots(discoveredPosts.length);
  let tasksCreated = [];

  discoveredPosts.forEach((post, index) => {
    const taskId = `task_${Date.now()}_${index}`;
    const destDir = path.join(__dirname, 'public', 'media_library', taskId);
    fs.mkdirSync(destDir, { recursive: true });

    // Copy images/media to media_library
    post.images.forEach(img => {
      fs.copyFileSync(path.join(post.dirPath, img), path.join(destDir, img));
    });
    post.videos.forEach(vid => {
      fs.copyFileSync(path.join(post.dirPath, vid), path.join(destDir, vid));
    });

    if (post.caption) {
      fs.writeFileSync(path.join(destDir, 'caption.txt'), post.caption, 'utf8');
    }

    const slot = targetSlots[index] || targetSlots[0];
    const mediaType = post.images.length > 0 ? 'slideshow' : 'video';

    const newTask = {
      id: taskId,
      profileId,
      subAccountId,
      platforms: Array.isArray(platforms) && platforms.length ? platforms : ['tiktok'],
      caption: post.caption,
      phoneWall: slot.wall,
      scheduledTime: tiktokStudio.wallToNaiveIso(slot.wall),
      mediaPath: destDir,
      fileName: post.name || path.basename(zipPath, '.zip'),
      mediaType,
      status: 'pending',
      results: {}
    };

    schedule.push(newTask);
    tasksCreated.push(newTask);
  });

  // Cleanup temp extract folder
  try { execSync(`rm -rf "${tempExtractDir}"`); } catch {}
  // Cleanup original ZIP
  try { fs.unlinkSync(zipPath); } catch {}

  saveSchedule(schedule);
  return tasksCreated;
}

module.exports = {
  loadSchedule,
  saveSchedule,
  loadProfiles,
  saveProfiles,
  processNextScheduledItem,
  startSchedulerLoop,
  importZipArchive,
  processItemImmediately,
  deleteTasks
};
