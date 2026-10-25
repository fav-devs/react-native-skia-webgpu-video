package com.azzapp.rnskv;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.util.Random;

import org.junit.Test;

/** Same cases as test/native/ItemTimeTest.cpp. */
public class ItemTimeTest {

  private static long s(double seconds) {
    return Math.round(seconds * 1e6);
  }

  @Test
  public void theSpanScalesWithTheRate() {
    assertEquals(s(2), ItemTime.sourceSpanUs(s(2), 1));
    assertEquals(s(4), ItemTime.sourceSpanUs(s(2), 2));
    assertEquals(s(1), ItemTime.sourceSpanUs(s(2), 0.5));
    // Before the item: not held.
    assertEquals(-s(1), ItemTime.sourceSpanUs(-s(0.5), 2));
  }

  @Test
  public void oneXIsExact() {
    Random random = new Random(3);
    for (int i = 0; i < 100_000; i++) {
      long us = (long) (random.nextDouble() * s(4 * 3600)) - s(3600);
      assertEquals(us, ItemTime.sourceSpanUs(us, 1));
    }
  }

  @Test
  public void theOffsetIsHeldToTheItem() {
    assertEquals(0, ItemTime.heldOffsetUs(s(10), s(4), s(9)));
    assertEquals(s(4), ItemTime.heldOffsetUs(s(10), s(4), s(20)));
    assertEquals(s(1.5), ItemTime.heldOffsetUs(s(10), s(4), s(11.5)));
  }

  @Test
  public void anItemMovesBackOnlyWhenItsHeldPositionDoes() {
    assertTrue(ItemTime.movesBack(s(10), s(4), s(12), s(11)));
    assertFalse(ItemTime.movesBack(s(10), s(4), s(11), s(12)));
    assertFalse(ItemTime.movesBack(s(10), s(4), s(12), s(12)));
    assertTrue(ItemTime.movesBack(s(10), s(4), s(20), s(13)));
    assertTrue(ItemTime.movesBack(s(10), s(4), s(12), s(5)));
    assertFalse(ItemTime.movesBack(s(10), s(4), s(9.5), s(9)));
    assertFalse(ItemTime.movesBack(s(10), s(4), s(20), s(15)));
  }

  @Test
  public void aLaterRequestNeverSeeksBack() {
    Random random = new Random(7);
    for (int i = 0; i < 200_000; i++) {
      long compositionStart = (long) (random.nextDouble() * s(20));
      long duration = s(0.1) + (long) (random.nextDouble() * s(10));
      double rate = 0.05 + random.nextDouble() * 8;
      long a = (long) (random.nextDouble() * s(40));
      long b = a + (long) (random.nextDouble() * s(5));
      assertFalse(ItemTime.movesBack(compositionStart, duration, a, b));
      assertTrue(ItemTime.sourceSpanUs(b - compositionStart, rate)
        >= ItemTime.sourceSpanUs(a - compositionStart, rate));
    }
  }
}
