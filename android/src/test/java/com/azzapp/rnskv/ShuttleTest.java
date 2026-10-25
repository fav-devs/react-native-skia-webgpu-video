package com.azzapp.rnskv;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Random;

import org.junit.Test;

/** Same cases as test/native/ShuttleTest.cpp. */
public class ShuttleTest {

  private static long s(double seconds) {
    return Math.round(seconds * 1e6);
  }

  /** A 30 fps file, frame i at i / 30. */
  private static long frame(int i) {
    return Math.round(i * 1e6 / 30);
  }

  private static final long FRAME_US = frame(1);

  /**
   * The frames a codec produces from the window's decodeFrom (from the frame
   * on screen at that time, as an extractor sought there does), kept as a
   * window does: what VideoCompositionItemDecoder does with real frames.
   * Returns {pts..., until...} of the kept frames, and the frames decoded in
   * decoded[0].
   */
  private static long[][] decodeWindow(Shuttle.Window window, int capacity, int frames,
      int[] decoded) {
    List<Long> kept = new ArrayList<>();
    boolean candidate = false;
    int count = 0;
    for (int i = 0; i < frames; i++) {
      long pts = frame(i);
      if (frame(i + 1) <= window.decodeFromUs) continue;
      count++;
      int admitted = Shuttle.admit(pts, window);
      if (admitted == Shuttle.STOP) break;
      if (admitted == Shuttle.BEFORE) {
        if (candidate) kept.remove(kept.size() - 1);
        kept.add(pts);
        candidate = true;
        continue;
      }
      candidate = false;
      kept.add(pts);
      if (kept.size() > capacity) kept.remove(0);
    }
    if (decoded != null) decoded[0] = count;
    long[] pts = kept.stream().mapToLong(Long::longValue).toArray();
    return new long[][]{pts, Shuttle.untilOf(pts, window)};
  }

  @Test
  public void theDirectionHoldsAtZero() {
    assertTrue(Shuttle.backwardAt(-0.1, false));
    assertFalse(Shuttle.backwardAt(0.1, true));
    assertTrue(Shuttle.backwardAt(0, true));
    assertFalse(Shuttle.backwardAt(0, false));
  }

  @Test
  public void theClockMovesAtItsRateWithinTheComposition() {
    long duration = s(60);
    assertEquals(s(5), new Shuttle.Clock(s(3), s(10), 2).at(s(11), duration));
    assertEquals(s(2), new Shuttle.Clock(s(3), s(10), -1).at(s(11), duration));
    assertEquals(s(3), new Shuttle.Clock(s(3), s(10), 0).at(s(50), duration));
    assertEquals(0, new Shuttle.Clock(s(3), s(10), -4).at(s(11), duration));
    assertEquals(duration, new Shuttle.Clock(s(3), s(10), 4).at(s(100), duration));
    // 1× is exactly the wall clock, as before signed rates.
    Random random = new Random(5);
    for (int i = 0; i < 10_000; i++) {
      long anchor = (long) (random.nextDouble() * s(30));
      long start = (long) (random.nextDouble() * s(1000));
      long now = start + (long) (random.nextDouble() * s(20));
      assertEquals(anchor + now - start, new Shuttle.Clock(anchor, start, 1).at(now, s(100)));
    }
    assertTrue(Shuttle.reachedStart(0, -1));
    assertFalse(Shuttle.reachedStart(1, -1));
    assertFalse(Shuttle.reachedStart(0, 1));
    assertFalse(Shuttle.reachedStart(0, 0));
  }

  @Test
  public void twoWindowsStayWithinTheBudget() {
    assertEquals(16, Shuttle.windowCapacity(1280L * 720 * 4 / 4 * 3 / 2));
    assertEquals(4, Shuttle.windowCapacity(1920L * 1080 * 4));
    assertEquals(1, Shuttle.windowCapacity(3840L * 2160 * 4));
    assertEquals(16, Shuttle.windowCapacity(0));
    for (long bytes = 1; bytes < 200_000_000L; bytes = bytes * 3 / 2 + 1) {
      int capacity = Shuttle.windowCapacity(bytes);
      long total = (long) capacity * Shuttle.WINDOWS;
      assertTrue(total <= Shuttle.MAX_FRAMES);
      // One frame a window is the least a window holds, whatever its size.
      assertTrue(capacity == 1 || total * bytes <= Shuttle.MAX_BYTES);
    }
  }

  @Test
  public void windowsEndBelowWhatIsCoveredAndAtThePlayhead() {
    assertEquals(s(2) + Shuttle.END_MARGIN_US, Shuttle.nextEnd(-1, s(2)));
    assertEquals(s(1.5), Shuttle.nextEnd(s(1.5), s(2)));
    assertEquals(s(1) + Shuttle.END_MARGIN_US, Shuttle.nextEnd(s(1.5), s(1)));
  }

  @Test
  public void windowsFollowTheGroupsOfPictures() {
    long[] syncs = new long[11];
    for (int i = 0; i <= 10; i++) syncs[i] = s(i);
    Shuttle.Window window = Shuttle.planWindow(s(5.9), 0, FRAME_US, 16, syncs);
    assertNotNull(window);
    assertEquals(s(5.9) - 16 * FRAME_US, window.startUs);
    assertEquals(s(5), window.decodeFromUs);
    assertEquals(s(5.9), window.endUs);
    window = Shuttle.planWindow(s(5.5), 0, FRAME_US, 16, syncs);
    assertEquals(s(5), window.startUs);
    assertEquals(s(5), window.decodeFromUs);
    long[] shortGroups = new long[101];
    for (int i = 0; i <= 100; i++) shortGroups[i] = s(i * 0.25);
    window = Shuttle.planWindow(s(5), 0, FRAME_US, 16, shortGroups);
    assertEquals(s(4.5), window.startUs);
    assertEquals(s(4.5), window.decodeFromUs);
    assertNull(Shuttle.planWindow(s(3), s(3), FRAME_US, 16, syncs));
    window = Shuttle.planWindow(s(3.2), s(3.05), FRAME_US, 16, syncs);
    assertEquals(s(3.05), window.startUs);
    assertEquals(s(3), window.decodeFromUs);
    window = Shuttle.planWindow(s(5.5), 0, FRAME_US, 16, new long[0]);
    assertEquals(s(5.5) - 16 * FRAME_US, window.startUs);
    assertEquals(window.startUs, window.decodeFromUs);
    window = Shuttle.planWindow(s(0.3), 0, FRAME_US, 16, new long[0]);
    assertEquals(0, window.startUs);
    assertEquals(0, window.decodeFromUs);
  }

  @Test
  public void fourExtractorSeeksPlanTheSameWindowAsTheWholeTable() {
    Random random = new Random(13);
    for (int run = 0; run < 5_000; run++) {
      List<Long> table = new ArrayList<>();
      long time = (long) (random.nextDouble() * s(0.5));
      while (time < s(30)) {
        table.add(time);
        time += s(0.1) + (long) (random.nextDouble() * s(4));
      }
      long[] syncs = table.stream().mapToLong(Long::longValue).toArray();
      Shuttle.SyncIndex index = new Shuttle.SyncIndex() {
        @Override public long previous(long timeUs) {
          return Shuttle.syncAtOrBefore(syncs, timeUs);
        }

        @Override public long next(long timeUs) {
          for (long sync : syncs) if (sync >= timeUs) return sync;
          return -1;
        }
      };
      long floor = (long) (random.nextDouble() * s(10));
      long end = floor + (long) (random.nextDouble() * s(20)) - s(1);
      int capacity = 1 + random.nextInt(16);
      Shuttle.Window whole = Shuttle.planWindow(end, floor, FRAME_US, capacity, syncs);
      Shuttle.Window asked = Shuttle.planWindow(end, floor, FRAME_US, capacity, index);
      if (whole == null) {
        assertNull(asked);
        continue;
      }
      assertNotNull(asked);
      assertEquals(whole.decodeFromUs, asked.decodeFromUs);
      assertEquals(whole.startUs, asked.startUs);
      assertEquals(whole.endUs, asked.endUs);
    }
  }

  @Test
  public void aWindowKeepsTheFrameAtItsStartAndItsLatestFrames() {
    Shuttle.Window window = Shuttle.planWindow(frame(40) + 1, frame(25) + 1000, FRAME_US, 32,
      new long[0]);
    long[][] kept = decodeWindow(window, 32, 300, null);
    assertEquals(frame(25), kept[0][0]);
    assertEquals(frame(40), kept[0][kept[0].length - 1]);
    assertEquals(window.endUs, kept[1][kept[1].length - 1]);
    assertEquals(frame(26), kept[1][0]);
    Shuttle.Window narrow = new Shuttle.Window(0, frame(10), frame(30));
    kept = decodeWindow(narrow, 4, 300, null);
    assertEquals(4, kept[0].length);
    assertEquals(frame(26), kept[0][0]);
    assertEquals(frame(26), Shuttle.coveredFrom(kept[0], narrow));
    assertEquals(frame(10), Shuttle.coveredFrom(new long[0], narrow));
  }

  @Test
  public void theFrameShownBackwardIsNeverAheadOfTheClock() {
    long[] pts = new long[10];
    long[] until = new long[10];
    for (int i = 0; i < 10; i++) {
      pts[i] = frame(i + 10);
      until[i] = frame(i + 11);
    }
    long clock = frame(15) + 10_000;
    assertArrayEquals(new int[]{5, 5}, Shuttle.pickBackward(pts, until, 10, clock, -1));
    assertArrayEquals(new int[]{5, 5}, Shuttle.pickBackward(pts, until, 10, clock, frame(16)));
    // The frame on screen is not shown again.
    assertArrayEquals(new int[]{-1, 5}, Shuttle.pickBackward(pts, until, 10, clock, frame(15)));
    // Held frames below the clock wait for it.
    assertArrayEquals(new int[]{-1, 10}, Shuttle.pickBackward(pts, until, 10, frame(25), frame(30)));
    // A clock below everything decoded: the nearest frame behind it.
    assertArrayEquals(new int[]{0, 0}, Shuttle.pickBackward(pts, until, 10, frame(5), frame(30)));
    // In a stretch no window covers: the frame behind, not the one ahead.
    long[] gap = {frame(2), frame(8)};
    long[] gapUntil = {frame(3), frame(9)};
    assertArrayEquals(new int[]{1, 1}, Shuttle.pickBackward(gap, gapUntil, 2, frame(5), -1));
    assertArrayEquals(new int[]{-1, 0}, Shuttle.pickBackward(new long[0], new long[0], 0, s(1), -1));
  }

  @Test
  public void aRandomBackwardRunShowsTheRightFramesAndKeepsMoving() {
    Random random = new Random(11);
    for (int run = 0; run < 300; run++) {
      final int count = 600;
      long floor = frame((int) (random.nextDouble() * 60));
      double rate = 0.2 + random.nextDouble() * 4;
      double decodePerTick = 0.5 + random.nextDouble() * 8;
      int capacity = 1 + (int) (random.nextDouble() * 16);
      List<Long> table = new ArrayList<>();
      long group = s(0.2 + random.nextDouble() * 3);
      for (long t = 0; t < frame(count); t += group) table.add(t);
      long[] syncs = table.stream().mapToLong(Long::longValue).toArray();
      long position = frame(count - 1) - (long) (random.nextDouble() * s(2));
      long[] heldPts = new long[0];
      long[] heldUntil = new long[0];
      int[] heldWindow = new int[0];
      long covered = -1;
      long shown = -1;
      double work = 0;
      Shuttle.Window pending = null;
      int[] cost = new int[1];
      int windowId = 0;
      int sinceShown = 0;
      for (int tick = 0; tick < 100_000 && position > floor; tick++) {
        int windows = 0;
        for (int i = 0; i < heldWindow.length; i++)
          if (i == 0 || heldWindow[i] != heldWindow[i - 1]) windows++;
        if (pending == null && windows < Shuttle.WINDOWS && (covered < 0 || covered > floor)) {
          pending = Shuttle.planWindow(Shuttle.nextEnd(covered, position), floor, FRAME_US,
            capacity, syncs);
          if (pending != null) {
            decodeWindow(pending, capacity, count, cost);
            work = 0;
          }
        }
        if (pending != null && (work += decodePerTick) >= cost[0]) {
          long[][] decoded = decodeWindow(pending, capacity, count, null);
          covered = Shuttle.coveredFrom(decoded[0], pending);
          heldPts = concat(decoded[0], heldPts);
          heldUntil = concat(decoded[1], heldUntil);
          int[] ids = new int[decoded[0].length];
          Arrays.fill(ids, ++windowId);
          int[] merged = new int[ids.length + heldWindow.length];
          System.arraycopy(ids, 0, merged, 0, ids.length);
          System.arraycopy(heldWindow, 0, merged, ids.length, heldWindow.length);
          heldWindow = merged;
          pending = null;
        }
        long clock = position + 1;
        int[] chosen = Shuttle.pickBackward(heldPts, heldUntil, heldPts.length, clock, shown);
        if (chosen[0] >= 0) {
          long pts = heldPts[chosen[0]];
          long frameUntil = heldUntil[chosen[0]];
          assertFalse("a frame ahead of the clock", frameUntil <= position && pts <= position);
          assertTrue("the picture moved forward", shown < 0 || pts < shown);
          shown = pts;
          sinceShown = 0;
        } else {
          assertFalse("stalled", ++sinceShown > 240 && position > floor + s(2));
        }
        heldPts = Arrays.copyOf(heldPts, chosen[1]);
        heldUntil = Arrays.copyOf(heldUntil, chosen[1]);
        heldWindow = Arrays.copyOf(heldWindow, chosen[1]);
        for (int i = 0; i < heldPts.length; i++)
          assertFalse("the exact frame was decoded but not shown",
            heldPts[i] <= clock && clock < heldUntil[i]);
        position = Math.max(floor, position - Math.round(rate * 1e6 / 60));
      }
      if (pending != null) {
        long[][] decoded = decodeWindow(pending, capacity, count, null);
        covered = Shuttle.coveredFrom(decoded[0], pending);
        heldPts = concat(decoded[0], heldPts);
        heldUntil = concat(decoded[1], heldUntil);
      }
      for (int tick = 0; tick < 2000; tick++) {
        if (heldPts.length == 0 && (covered < 0 || covered > floor)) {
          Shuttle.Window next = Shuttle.planWindow(Shuttle.nextEnd(covered, floor), floor,
            FRAME_US, capacity, syncs);
          if (next != null) {
            long[][] decoded = decodeWindow(next, capacity, count, null);
            covered = Shuttle.coveredFrom(decoded[0], next);
            heldPts = decoded[0];
            heldUntil = decoded[1];
          }
        }
        int[] chosen = Shuttle.pickBackward(heldPts, heldUntil, heldPts.length, floor + 1, shown);
        if (chosen[0] >= 0) shown = heldPts[chosen[0]];
        heldPts = Arrays.copyOf(heldPts, chosen[1]);
        heldUntil = Arrays.copyOf(heldUntil, chosen[1]);
      }
      assertEquals("ends on the item's first frame", floor, shown);
    }
  }

  @Test
  public void aFastForwardCodecCatchesUpOnlyWhenFarBehind() {
    assertFalse(Shuttle.catchUp(0, s(10), 1, -1));
    assertFalse(Shuttle.catchUp(0, s(10), -1, -1));
    assertFalse(Shuttle.catchUp(s(9), s(10), 4, -1));
    assertTrue(Shuttle.catchUp(s(7), s(10), 4, -1));
    assertFalse(Shuttle.catchUp(s(5), s(10), 4, s(6)));
    assertTrue(Shuttle.catchUp(s(6), s(10), 4, s(6)));
    assertFalse(Shuttle.catchUp(-1, s(10), 4, -1));
  }

  private static long[] concat(long[] first, long[] second) {
    long[] result = Arrays.copyOf(first, first.length + second.length);
    System.arraycopy(second, 0, result, first.length, second.length);
    return result;
  }
}
