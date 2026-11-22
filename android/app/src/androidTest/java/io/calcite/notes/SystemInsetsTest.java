package io.calcite.notes;

import static org.junit.Assert.assertEquals;

import android.view.View;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.filters.SdkSuppress;
import org.junit.Test;
import org.junit.runner.RunWith;

@RunWith(AndroidJUnit4.class)
@SdkSuppress(minSdkVersion = 35)
public class SystemInsetsTest {
    @Test
    public void contentAvoidsSystemBarsAndKeyboard() {
        try (ActivityScenario<MainActivity> activity = ActivityScenario.launch(MainActivity.class)) {
            activity.onActivity(screen -> {
                View content = screen.findViewById(android.R.id.content);
                int bars = WindowInsetsCompat.Type.systemBars();
                int cutout = WindowInsetsCompat.Type.displayCutout();
                int ime = WindowInsetsCompat.Type.ime();
                WindowInsetsCompat system = new WindowInsetsCompat.Builder()
                    .setInsets(bars, Insets.of(0, 28, 0, 24))
                    .setInsets(cutout, Insets.of(12, 0, 10, 0))
                    .setVisible(bars | cutout, true)
                    .build();

                WindowInsetsCompat remaining = ViewCompat.dispatchApplyWindowInsets(content, system);
                assertEquals(28, content.getPaddingTop());
                assertEquals(24, content.getPaddingBottom());
                assertEquals(12, content.getPaddingLeft());
                assertEquals(10, content.getPaddingRight());
                assertEquals(Insets.NONE, remaining.getInsets(bars | cutout));

                WindowInsetsCompat keyboard = new WindowInsetsCompat.Builder(system)
                    .setInsets(ime, Insets.of(0, 0, 0, 280))
                    .setVisible(ime, true)
                    .build();
                ViewCompat.dispatchApplyWindowInsets(content, keyboard);
                assertEquals(28, content.getPaddingTop());
                assertEquals(280, content.getPaddingBottom());
            });
        }
    }
}
