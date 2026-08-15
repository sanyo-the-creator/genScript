// One-off orchestrator: schedule the 3 slideshow folders currently in the
// schedule queue, in order, at phone-local 15/18/21 (±10min) slots, using the
// fixed TikTok Studio flow. Updates graphene_schedule.json statuses for the UI.
const fs = require('fs');
const path = require('path');
const tt = require('./tiktok_studio');
const s = require('./social_scheduler');

const nat = (a, b) => a.localeCompare(b, undefined, { numeric: true });

(async () => {
  const sched = s.loadSchedule();
  const slots = tt.nextPhoneSlots(sched.length);
  console.log('Phone now:', JSON.stringify(tt.getPhoneNow()));
  console.log('Slots:', slots.map((x) => x.label).join('  |  '));

  for (let i = 0; i < sched.length; i++) {
    const task = sched[i];
    const dir = task.mediaPath;
    const imgs = fs.readdirSync(dir)
      .filter((f) => /\.(png|jpg|jpeg|webp)$/i.test(f)).sort(nat)
      .map((f) => path.join(dir, f));
    const txt = fs.readdirSync(dir).find((f) => /\.txt$/i.test(f));
    const caption = txt ? fs.readFileSync(path.join(dir, txt), 'utf8').trim() : '';
    const slot = slots[i];

    console.log(`\n=== [${i + 1}/${sched.length}] ${task.fileName} @ phone ${slot.label} (${imgs.length} imgs) ===`);
    task.status = 'running';
    task.results = { tiktok: { status: 'running' } };
    s.saveSchedule(sched);

    try {
      await tt.scheduleSlideshow({
        userId: 14, mediaFiles: imgs, caption, schedule: slot, debugShots: true,
      });
      task.status = 'success';
      task.results = { tiktok: { status: 'success', postedAt: new Date().toISOString() } };
      console.log(`✅ ${task.fileName} scheduled at phone ${slot.label}`);
    } catch (e) {
      task.status = 'failed';
      task.results = { tiktok: { status: 'failed', error: e.message } };
      console.error(`✗ ${task.fileName} failed:`, e.message);
    }
    s.saveSchedule(sched);
  }
  console.log('\nALL DONE');
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
