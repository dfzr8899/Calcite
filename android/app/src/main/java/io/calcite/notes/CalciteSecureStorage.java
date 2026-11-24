package io.calcite.notes;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;

@CapacitorPlugin(name = "CalciteSecureStorage")
public class CalciteSecureStorage extends Plugin {
    private static final String ALIAS = "io.calcite.notes.sync.v1";
    private static final String FORMAT = "AES/GCM/NoPadding";

    private SharedPreferences preferences() {
        return getContext().getSharedPreferences(ALIAS, Context.MODE_PRIVATE);
    }

    private synchronized SecretKey key() throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore");
        store.load(null);
        if (store.containsAlias(ALIAS)) return (SecretKey) store.getKey(ALIAS, null);
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        generator.init(new KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256).build());
        return generator.generateKey();
    }

    private String record(PluginCall call) {
        String name = call.getString("key");
        if (name == null || !name.matches("[0-9a-f-]{36}\\.(pat|peer)")) throw new IllegalArgumentException();
        return name;
    }

    @PluginMethod public void available(PluginCall call) {
        try { key(); call.resolve(new JSObject().put("available", true)); }
        catch (Exception ignored) { call.resolve(new JSObject().put("available", false)); }
    }

    @PluginMethod public void get(PluginCall call) {
        try {
            String name = record(call);
            String saved = preferences().getString(name, null);
            if (saved == null) { call.resolve(new JSObject()); return; }
            String[] fields = saved.split("\\.", 2);
            Cipher cipher = Cipher.getInstance(FORMAT);
            cipher.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(128, Base64.decode(fields[0], Base64.NO_WRAP)));
            cipher.updateAAD(name.getBytes(StandardCharsets.UTF_8));
            call.resolve(new JSObject().put("value", new String(cipher.doFinal(Base64.decode(fields[1], Base64.NO_WRAP)), StandardCharsets.UTF_8)));
        } catch (Exception ignored) { call.reject(CalciteLanguage.text(getContext(), R.string.secure_unavailable)); }
    }

    @PluginMethod public void set(PluginCall call) {
        try {
            String name = record(call);
            String value = call.getString("value", "");
            if (value.length() > 2048) throw new IllegalArgumentException();
            SharedPreferences.Editor edit = preferences().edit();
            if (value.isEmpty()) edit.remove(name);
            else {
                Cipher cipher = Cipher.getInstance(FORMAT);
                cipher.init(Cipher.ENCRYPT_MODE, key());
                cipher.updateAAD(name.getBytes(StandardCharsets.UTF_8));
                edit.putString(name, Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP) + "." +
                        Base64.encodeToString(cipher.doFinal(value.getBytes(StandardCharsets.UTF_8)), Base64.NO_WRAP));
            }
            if (!edit.commit()) throw new IllegalStateException();
            call.resolve();
        } catch (Exception ignored) { call.reject(CalciteLanguage.text(getContext(), R.string.secure_save_failed)); }
    }

    @PluginMethod public void decryptPair(PluginCall call) {
        try {
            String encodedKey = call.getString("key");
            String encodedIv = call.getString("iv");
            String encodedData = call.getString("data");
            if (encodedKey == null || encodedIv == null || encodedData == null || encodedData.length() > 16000) {
                throw new IllegalArgumentException();
            }
            byte[] rawKey = Base64.decode(encodedKey, Base64.DEFAULT);
            byte[] iv = Base64.decode(encodedIv, Base64.DEFAULT);
            byte[] data = Base64.decode(encodedData, Base64.DEFAULT);
            if (rawKey.length != 32 || iv.length != 12 || data.length < 16) throw new IllegalArgumentException();
            Cipher cipher = Cipher.getInstance(FORMAT);
            cipher.init(Cipher.DECRYPT_MODE, new SecretKeySpec(rawKey, "AES"), new GCMParameterSpec(128, iv));
            String plaintext = new String(cipher.doFinal(data), StandardCharsets.UTF_8);
            call.resolve(new JSObject().put("value", plaintext));
        } catch (Exception ignored) { call.reject(CalciteLanguage.text(getContext(), R.string.secure_unavailable)); }
    }
}
