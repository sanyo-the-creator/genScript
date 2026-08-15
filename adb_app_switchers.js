// adb_app_switchers.js - defines package names and UI percentage coordinates for switching accounts.
// Coordinates are represented as [xRatio, yRatio] (0.0 to 1.0) and multiplied by screen size dynamically.

module.exports = {
  tiktok: {
    // NOTE: TikTok photo slideshows are handled by tiktok_studio.js, not this
    // generic step engine. These fields remain for reference / non-slideshow use.
    packageName: 'com.ss.android.tt.creator',
    activityName: 'com.ss.android.ugc.aweme.splash.SplashActivity',
    // Steps to switch account in TikTok Studio app
    switchSteps: [
      { action: 'tap', x: 0.90, y: 0.95, delay: 3000, desc: 'Tap profile tab' },
      { action: 'tap', x: 0.50, y: 0.07, delay: 2000, desc: 'Tap account switcher dropdown' },
      {
        action: 'branch',
        accounts: [
          { action: 'tap', x: 0.50, y: 0.70, delay: 3000, desc: 'Select Account 1' },
          { action: 'tap', x: 0.50, y: 0.78, delay: 3000, desc: 'Select Account 2' },
          { action: 'tap', x: 0.50, y: 0.86, delay: 3000, desc: 'Select Account 3' }
        ]
      }
    ],
    // Steps to navigate, upload, and schedule in TikTok Studio
    postSteps: [
      { action: 'tap', x: 0.50, y: 0.95, delay: 3000, desc: 'Tap Create / + button' },
      { action: 'tap', x: 0.85, y: 0.80, delay: 3000, desc: 'Tap Upload from Device' },
      { action: 'tap', x: 0.15, y: 0.25, delay: 2000, desc: 'Select first video' },
      { action: 'tap', x: 0.85, y: 0.95, delay: 4000, desc: 'Tap Next' },
      
      // Autonomous Sound Selection:
      { action: 'tap', x: 0.50, y: 0.08, delay: 2000, desc: 'Tap Add Sound button' },
      { action: 'tap', x: 0.15, y: 0.35, delay: 2000, desc: 'Tap Saved/Favorites tab' },
      { action: 'tap_random_saved_sound', delay: 2000, desc: 'Select a random saved sound from favorites' },
      { action: 'tap', x: 0.85, y: 0.45, delay: 2000, desc: 'Apply selected sound' },
      { action: 'tap', x: 0.10, y: 0.08, delay: 2000, desc: 'Exit sound panel back to editor' },
      { action: 'tap', x: 0.85, y: 0.95, delay: 3000, desc: 'Tap Next' },

      { action: 'tap', x: 0.50, y: 0.30, delay: 2000, desc: 'Focus caption input box' },
      { action: 'input_text', delay: 1000, desc: 'Type caption text' },
      { action: 'tap', x: 0.50, y: 0.60, delay: 2000, desc: 'Tap Schedule / Post Options' },
      { action: 'tap', x: 0.80, y: 0.60, delay: 2000, desc: 'Toggle Schedule option on' },
      { action: 'tap', x: 0.50, y: 0.70, delay: 2000, desc: 'Tap Date/Time selector' },
      // Note: Date/time input can be selected manually or confirmed via OK
      { action: 'tap', x: 0.80, y: 0.90, delay: 2000, desc: 'Confirm Schedule Time (OK)' },
      { action: 'tap', x: 0.80, y: 0.95, delay: 5000, desc: 'Tap Schedule Post button' }
    ]
  },
  instagram: {
    packageName: 'com.instagram.android',
    activityName: 'com.instagram.mainactivity.MainActivity',
    switchSteps: [
      { action: 'tap', x: 0.90, y: 0.95, delay: 3000, desc: 'Tap profile tab' },
      { action: 'tap', x: 0.25, y: 0.07, delay: 2000, desc: 'Tap account dropdown at top' },
      {
        action: 'branch',
        accounts: [
          { action: 'tap', x: 0.50, y: 0.75, delay: 3000, desc: 'Select Account 1' },
          { action: 'tap', x: 0.50, y: 0.82, delay: 3000, desc: 'Select Account 2' },
          { action: 'tap', x: 0.50, y: 0.89, delay: 3000, desc: 'Select Account 3' }
        ]
      }
    ],
    postSteps: [
      { action: 'tap', x: 0.50, y: 0.95, delay: 3000, desc: 'Tap + button' },
      { action: 'tap', x: 0.15, y: 0.35, delay: 3000, desc: 'Select first media' },
      { action: 'tap', x: 0.90, y: 0.07, delay: 3000, desc: 'Tap Next/Arrow' },
      { action: 'tap', x: 0.90, y: 0.07, delay: 3000, desc: 'Tap Next/Arrow again' },
      { action: 'tap', x: 0.50, y: 0.20, delay: 2000, desc: 'Focus caption' },
      { action: 'input_text', delay: 1000, desc: 'Type caption' },
      { action: 'tap', x: 0.50, y: 0.95, delay: 5000, desc: 'Tap Share' }
    ]
  },
  threads: {
    packageName: 'com.instagram.barcelona',
    activityName: 'com.instagram.barcelona.navigation.SecureActivityDelegate',
    switchSteps: [
      { action: 'tap', x: 0.90, y: 0.95, delay: 3000, desc: 'Tap profile tab' },
      { action: 'tap', x: 0.90, y: 0.07, delay: 2000, desc: 'Tap settings/menu icon' },
      { action: 'tap', x: 0.50, y: 0.85, delay: 2000, desc: 'Tap Switch Accounts' },
      {
        action: 'branch',
        accounts: [
          { action: 'tap', x: 0.50, y: 0.60, delay: 4000, desc: 'Select Account 1' },
          { action: 'tap', x: 0.50, y: 0.68, delay: 4000, desc: 'Select Account 2' },
          { action: 'tap', x: 0.50, y: 0.76, delay: 4000, desc: 'Select Account 3' }
        ]
      }
    ],
    postSteps: [
      { action: 'tap', x: 0.50, y: 0.95, delay: 3000, desc: 'Tap New Thread' },
      { action: 'tap', x: 0.50, y: 0.35, delay: 2000, desc: 'Focus text' },
      { action: 'input_text', delay: 1000, desc: 'Type thread content' },
      { action: 'tap', x: 0.08, y: 0.45, delay: 3000, desc: 'Tap attachment paperclip' },
      { action: 'tap', x: 0.15, y: 0.25, delay: 2000, desc: 'Select first attachment' },
      { action: 'tap', x: 0.90, y: 0.07, delay: 2000, desc: 'Tap Done' },
      { action: 'tap', x: 0.85, y: 0.92, delay: 5000, desc: 'Tap Post' }
    ]
  },
  x: {
    packageName: 'com.twitter.android',
    activityName: 'com.twitter.android.StartActivity',
    switchSteps: [
      { action: 'tap', x: 0.08, y: 0.07, delay: 3000, desc: 'Tap sidebar profile avatar' },
      { action: 'tap', x: 0.90, y: 0.07, delay: 2000, desc: 'Tap account overflow/dropdown' },
      {
        action: 'branch',
        accounts: [
          { action: 'tap', x: 0.70, y: 0.15, delay: 3000, desc: 'Select Account 1' },
          { action: 'tap', x: 0.70, y: 0.23, delay: 3000, desc: 'Select Account 2' },
          { action: 'tap', x: 0.70, y: 0.31, delay: 3000, desc: 'Select Account 3' }
        ]
      }
    ],
    postSteps: [
      { action: 'tap', x: 0.88, y: 0.88, delay: 3000, desc: 'Tap Compose (+)' },
      { action: 'tap', x: 0.50, y: 0.30, delay: 2000, desc: 'Focus post text' },
      { action: 'input_text', delay: 1000, desc: 'Type tweet content' },
      { action: 'tap', x: 0.08, y: 0.92, delay: 2000, desc: 'Tap Gallery icon' },
      { action: 'tap', x: 0.15, y: 0.25, delay: 2000, desc: 'Select first media' },
      { action: 'tap', x: 0.90, y: 0.07, delay: 2000, desc: 'Tap Add' },
      { action: 'tap', x: 0.90, y: 0.07, delay: 5000, desc: 'Tap Post' }
    ]
  }
};
