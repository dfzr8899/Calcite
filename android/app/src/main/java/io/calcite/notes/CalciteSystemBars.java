package io.calcite.notes;

import android.app.Activity;
import android.graphics.Color;
import android.view.View;
import android.view.Window;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "CalciteSystemBars")
public class CalciteSystemBars extends Plugin {
    @PluginMethod
    public void setAppearance(PluginCall call) {
        boolean light = "light".equals(call.getString("theme", "dark"));
        Activity activity = getActivity();
        if (activity == null) {
            call.resolve();
            return;
        }
        activity.runOnUiThread(() -> {
            Window window = activity.getWindow();
            if (window == null) {
                call.resolve();
                return;
            }
            View decor = window.getDecorView();
            WindowInsetsControllerCompat bars = WindowCompat.getInsetsController(window, decor);
            bars.setAppearanceLightStatusBars(light);
            bars.setAppearanceLightNavigationBars(light);
            int color = Color.parseColor(light ? "#eceff4" : "#14161c");
            decor.setBackgroundColor(color);
            View content = activity.findViewById(android.R.id.content);
            if (content != null) content.setBackgroundColor(color);
            call.resolve();
        });
    }
}
