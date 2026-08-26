# Socials Scheduler Updates - Multi-Platform Support

## Summary
Extended the YouTube Shorts scheduler to support X/Twitter scheduling and an "All" option that schedules across all platforms sequentially. Added per-character login status tracking so only logged-in platforms appear as scheduling options.

## Changes Made

### 1. Frontend (public/youtube.html)

#### Added Features:
- **X/Twitter platform option** in the scheduling dropdown
- **"All (sequential)" option** that runs scheduleAll.js to post to all logged-in platforms
- **Login status checkboxes** for each character showing which platforms they're logged into
- Dynamic platform dropdown that only shows platforms where the character is logged in

#### Modified Components:
- `PLATFORMS` array: Added `schedulable: true` flag to track which platforms can be scheduled
- `charCard()`: Platform dropdown now dynamically built based on `loggedPlatforms` state
- `buildLoggedInputs()`: New function to create platform login checkboxes
- `getLoggedPlatforms()` / `setLoggedPlatforms()`: Manage login state
- `editChar()` / `resetForm()`: Updated to include loggedPlatforms
- `saveBtn.onclick`: Now saves loggedPlatforms to character data
- `runChar()`: Updated to handle all platform types (youtube, meta, x, threads, all)

### 2. Backend (server.js)

#### Added Constants:
```javascript
const X_UPLOAD_SCRIPT = path.join(__dirname, 'xUpload.js');
const THREADS_UPLOAD_SCRIPT = path.join(__dirname, 'threadsUpload.js');
const SCHEDULE_ALL_SCRIPT = path.join(__dirname, 'scheduleAll.js');
```

#### Enhanced `/api/yt/schedule` Endpoint:
- Now accepts `platform` values: 'youtube' | 'meta' | 'x' | 'threads' | 'all'
- **"all" platform handler**: 
  - Reads character's `loggedPlatforms`
  - Builds platform list dynamically (only logged-in platforms)
  - Spawns `scheduleAll.js` with the correct `--platforms` flag
  - Runs all platforms sequentially on the same debug Chrome
- **X/Twitter handler**:
  - Spawns `xUpload.js` with proper port and flags
  - Opens `https://x.com/home` in debug Chrome
- **Threads handler**:
  - Spawns `threadsUpload.js` (API-based, no Chrome needed)
- All handlers respect the shared scheduling parameters (perDay, start, tz, dryRun)

### 3. Character Data (yt_characters.json)

Added `loggedPlatforms` object to each character:
```json
{
  "loggedPlatforms": {
    "youtube": true,
    "facebook": false,
    "instagram": false,
    "x": false,
    "threads": false
  }
}
```

**Default state**: All characters default to YouTube-only login
**Jonathan Bale**: Set up with YouTube, Facebook, Instagram, and X all logged in (as noted in memory)

## How It Works

### Platform Selection Flow:
1. User checks which platforms a character is logged into (via checkboxes in edit form)
2. When scheduling, dropdown only shows logged-in platforms + "All" option
3. Selecting "All" runs all logged-in platforms sequentially via scheduleAll.js
4. Selecting individual platforms runs that platform's specific uploader

### "All" Platform Scheduling:
When user selects "All (sequential)":
1. Backend reads character's `loggedPlatforms`
2. Builds list of enabled platforms (youtube, fb, ig, x, threads)
3. Spawns `scheduleAll.js` with `--platforms=youtube,fb,ig,x,threads`
4. scheduleAll.js runs each platform sequentially on the same Chrome:
   - YouTube → ytUpload.js
   - Facebook → metaUpload.js --targets=fb
   - Instagram → metaUpload.js --targets=ig --reel
   - X → xUpload.js
   - Threads → threadsUpload.js (API, no Chrome)
5. Shared ledger prevents duplicate posts across platforms

### Individual Platform Scheduling:
- **YouTube**: Opens Studio, schedules Shorts (existing behavior)
- **Meta (FB + IG)**: Opens Business Suite, cross-posts to both (existing)
- **X**: Opens x.com/home, uses native Twitter scheduler
- **Threads**: API-based scheduling (no browser automation)

## Files Modified
- `public/youtube.html` - Frontend UI with new platform options and login checkboxes
- `server.js` - Backend scheduling logic for all platforms
- `yt_characters.json` - Added loggedPlatforms to all characters

## Files Used (No Changes)
- `scheduleAll.js` - Sequential multi-platform orchestrator (already existed)
- `xUpload.js` - X/Twitter scheduler (already existed)
- `threadsUpload.js` - Threads API scheduler (already existed)
- `ytUpload.js` - YouTube Shorts scheduler
- `metaUpload.js` - Facebook/Instagram scheduler

## Testing Checklist
- [ ] UI loads and shows login checkboxes
- [ ] Editing a character shows current login status
- [ ] Platform dropdown updates based on checked platforms
- [ ] "All" option appears when 2+ platforms are logged in
- [ ] Scheduling individual platforms works (YouTube, Meta, X, Threads)
- [ ] Scheduling "All" runs scheduleAll.js with correct platforms
- [ ] Unchecked platforms don't appear in dropdown
- [ ] Saving character preserves loggedPlatforms

## Notes
- Jonathan Bale (port 9202) is already set up with YouTube, FB, IG, and X logged in
- All other characters default to YouTube-only (can be changed via Edit)
- Threads requires Meta app setup + API tokens (see memory for details)
- The shared ledger system prevents duplicate posts across platforms
