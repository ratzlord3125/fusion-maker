// Looks inside a file the person picked: how long it is, whether this phone can read its
// picture and sound, and a small still image for the song list.
import * as MB from 'mediabunny';

/** An error whose message can be shown as it is. */
export class FileProblem extends Error {}

export async function probe(file) {
  const input = new MB.Input({ source: new MB.BlobSource(file), formats: MB.ALL_FORMATS });
  try {
    if (!(await input.canRead())) throw new FileProblem('is not a video or sound file');
    const video = await input.getPrimaryVideoTrack();
    const audio = await input.getPrimaryAudioTrack();
    const hasVideo = video ? await video.canDecode() : false;
    const hasAudio = audio ? await audio.canDecode() : false;
    if (!hasVideo && !hasAudio) throw new FileProblem('is in a format this phone cannot read');

    const duration = await input.computeDuration();
    if (!(duration > 0.5)) throw new FileProblem('is too short');

    const meta = {
      duration,
      hasVideo,
      hasAudio,
      audioRate: hasAudio ? await audio.getSampleRate() : 0,
      width: hasVideo ? await video.getDisplayWidth() : 0,
      height: hasVideo ? await video.getDisplayHeight() : 0,
      // What could not be read, so the person can be told.
      missing: video && !hasVideo ? 'picture' : audio && !hasAudio ? 'sound' : !audio ? 'nosound' : '',
    };

    let thumb = '';
    if (hasVideo) {
      try {
        const sink = new MB.CanvasSink(video, { width: 240, height: 136, fit: 'cover' });
        const first = await video.getFirstTimestamp();
        const still = await sink.getCanvas(first + Math.min(duration * 0.2, 12));
        if (still) thumb = still.canvas.toDataURL('image/jpeg', 0.72);
      } catch (err) {
        console.warn('No still image for', file.name, err);
      }
    }
    return { meta, thumb };
  } catch (err) {
    if (err instanceof FileProblem) throw err;
    console.warn('Could not read', file.name, err);
    throw new FileProblem('could not be read');
  } finally {
    input.dispose();
  }
}
