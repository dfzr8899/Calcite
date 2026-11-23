package io.calcite.notes;

import com.getcapacitor.BridgeActivity;
import android.content.Intent;
import android.os.Bundle;
import android.view.View;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(CalciteRichClipboard.class);
        registerPlugin(CalciteSecureStorage.class);
        registerPlugin(CalciteLegacyGitHttp.class);
        registerPlugin(CalciteDocumentPrint.class);
        // BridgeActivity forwards the launch Intent after loading the plugins.
        registerPlugin(CalciteExternalFiles.class);
        super.onCreate(savedInstanceState);
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
        View decor = getWindow().getDecorView();
        decor.post(() -> {
            WindowInsetsControllerCompat bars = WindowCompat.getInsetsController(getWindow(), decor);
            bars.setAppearanceLightStatusBars(false);
            bars.setAppearanceLightNavigationBars(false);
        });
        View content = findViewById(android.R.id.content);
        ViewCompat.setOnApplyWindowInsetsListener(content, (view, insets) -> {
            int system = WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout();
            int keyboard = WindowInsetsCompat.Type.ime();
            Insets bars = insets.getInsets(system);
            Insets ime = insets.getInsets(keyboard);
            view.setPadding(bars.left, bars.top, bars.right, Math.max(bars.bottom, ime.bottom));
            return new WindowInsetsCompat.Builder(insets).setInsets(system | keyboard, Insets.NONE).build();
        });
        ViewCompat.requestApplyInsets(content);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        setIntent(intent);
        super.onNewIntent(intent);
    }
}
