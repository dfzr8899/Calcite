package io.calcite.notes;

import android.content.Context;
import android.content.res.Configuration;
import java.util.Locale;

final class CalciteLanguage {
    private static final String SETTINGS = "calcite-interface";
    private static final String LOCALE = "locale";

    private CalciteLanguage() {}

    static void set(Context context, String value) {
        if ("zh-CN".equals(value) || "en-US".equals(value)) {
            context.getSharedPreferences(SETTINGS, Context.MODE_PRIVATE)
                .edit().putString(LOCALE, value).apply();
        }
    }

    static String text(Context context, int messageId) {
        Configuration configuration = new Configuration(context.getResources().getConfiguration());
        Locale system = configuration.getLocales().get(0);
        String chosen = context.getSharedPreferences(SETTINGS, Context.MODE_PRIVATE)
            .getString(LOCALE, "");
        Locale locale = chosen.isEmpty()
            ? ("zh".equals(system.getLanguage()) ? Locale.SIMPLIFIED_CHINESE : Locale.US)
            : Locale.forLanguageTag(chosen);
        configuration.setLocale(locale);
        return context.createConfigurationContext(configuration).getString(messageId);
    }
}
