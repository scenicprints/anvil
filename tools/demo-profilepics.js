/**
 * Profile pictures, and the picker that is the reason to have them.
 *
 * The picture is not decoration. Two profiles are two libraries, and picking
 * the wrong one means an evening's work saved into the wrong body of work. A
 * face is recognised before a word is read, which is what the picker is for.
 *
 * What is checked here is the round trip, because that is where this kind of
 * thing goes wrong: a picture that is written but comes back as nothing, or
 * comes back as the four-megabyte original that has to be thrown away every
 * time it is drawn.
 */

const dev = window.anvilDev;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const report = { errors: [] };
window.addEventListener('error', (e) => report.errors.push(`${e.message} @ ${e.filename}:${e.lineno}`));

/** A picture to set, made here rather than read off the disk. */
function testPicture(w, h, colour) {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = colour;
  ctx.fillRect(0, 0, w, h);
  // A mark off centre, so a crop that took the wrong part of the picture would
  // be visible rather than being a plain square either way.
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(w * 0.1, h * 0.1, w * 0.2, h * 0.2);
  return canvas.toDataURL('image/png');
}

const lib = await window.anvil.library?.();
report.profileNamed = lib?.profile?.name ?? null;
const id = lib?.profile?.id;
if (!id) return { ...report, stuckAt: 'there is no profile' };

/* ---- nobody starts with one ---- */
{
  await window.anvil.clearProfilePicture?.(id);
  const got = await window.anvil.profilePicture?.(id);
  report.startsWithNone = got?.picture === null;
}

/* ---- an oversized portrait is squared and scaled on the way in ---- */
{
  // Deliberately not square and deliberately far too big: a photograph off a
  // phone is the case this has to survive.
  const url = testPicture(900, 1600, '#2f7fbf');
  const bytes = await dev.squareThumbnail(url, 128);
  report.scaledDown = Array.isArray(bytes) && bytes.length > 0;
  report.bytesAreSmall = bytes.length < 64 * 1024;
  report.howManyBytes = bytes.length;

  const done = await window.anvil.setProfilePicture?.(id, bytes);
  report.pictureSet = done?.ok === true;
  report.cameBackAsAPicture = /^data:image\/png;base64,/.test(done?.picture || '');
}

/* ---- and it is there next time anybody asks ---- */
{
  const got = await window.anvil.profilePicture?.(id);
  report.readsBackAfterwards = /^data:image\/png;base64,/.test(got?.picture || '');

  // Square, and the size it was asked to be, which is what stops a photograph
  // being carried around at full size for ever.
  const img = new Image();
  await new Promise((resolve) => {
    img.onload = resolve;
    img.onerror = resolve;
    img.src = got.picture;
  });
  report.storedSize = `${img.naturalWidth}x${img.naturalHeight}`;
  report.isSquare = img.naturalWidth === img.naturalHeight && img.naturalWidth === 128;
}

/* ---- the list carries it, which is what the picker draws from ---- */
{
  const got = await window.anvil.profiles?.();
  const mine = got?.profiles.find((p) => p.id === id);
  report.listedWithItsPicture = /^data:image/.test(mine?.picture || '');
}

/* ---- a second profile, so the picker has something to pick between ---- */
{
  const made = await window.anvil.addProfile?.('Demo second profile');
  report.secondProfileMade = made?.ok === true;
  if (made?.ok) {
    const got = await window.anvil.profiles?.();
    report.nowAsksAtStartup = got.ask === true;
    // The new one has no picture, and that has to be an initial rather than a
    // blank: a gap where the others have a face reads as something broken.
    const fresh = got.profiles.find((p) => p.id === made.profile.id);
    report.newOneHasNoPicture = fresh?.picture === null;

    const face = dev.profileFace(fresh, 40);
    report.fallsBackToAnInitial = face.textContent === 'D' && !face.querySelector('img');
    const withPic = dev.profileFace(got.profiles.find((p) => p.id === id), 40);
    report.andDrawsTheImageWhenThereIsOne = !!withPic.querySelector('img');

    // Switching back, and then removing the demo profile so this run leaves
    // nothing behind. A test that litters somebody's profile list is a test
    // that gets deleted.
    await window.anvil.useProfile?.(id);
    const removed = await window.anvil.removeProfile?.(made.profile.id);
    report.tidiedUp = removed?.ok === true;
    const after = await window.anvil.profiles?.();
    report.backToOneProfile = after?.profiles.length === 1;
    report.andTheRightOne = after?.profiles[0]?.id === id;
  }
}

/* ---- and taking it off works ---- */
{
  await window.anvil.clearProfilePicture?.(id);
  const got = await window.anvil.profilePicture?.(id);
  report.canBeTakenOff = got?.picture === null;
}

report.finalErrors = (dev.state.result?.errors || []).map((e) => e.message);
return report;
