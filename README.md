# Etiket – APK ve IPA üretme rehberi

Bu klasör, `www/index.html` içindeki uygulamayı iOS ve Android'e saran bir Capacitor projesidir.

## Gerekenler
- Node.js 18+ (https://nodejs.org)
- Android: Android Studio (SDK 34+), JDK 17
- iOS: macOS + Xcode 15+, ücretsiz ya da ücretli Apple Developer hesabı

## 1) Kurulum (bir kez)
```
npm install
npx cap add android
npx cap add ios        # yalnızca macOS
```

## 2) Her değişiklikten sonra
```
npx cap sync
```

## 3) Android APK (test cihazı için)
```
npx cap open android
```
Android Studio'da: Build ▸ Build Bundle(s) / APK(s) ▸ Build APK(s).
APK: `android/app/build/outputs/apk/debug/app-debug.apk`
Telefonda "Bilinmeyen kaynaklardan yükleme"ye izin verip APK'yı kurun.
Mağaza için: Build ▸ Generate Signed Bundle (AAB) ve Google Play Console ($25 tek seferlik).

## 4) iOS (IPA)
```
npx cap open ios
```
Xcode'da: Signing & Capabilities ▸ Team seçin ▸ iPhone'u bağlayın ▸ Run (▶).
Ücretsiz Apple ID ile cihaza doğrudan kurulur (7 günde bir yenilenir).
IPA/TestFlight/App Store için Apple Developer Program ($99/yıl) gerekir: Product ▸ Archive ▸ Distribute.

## 5) Kamera izinleri
- Android: `android/app/src/main/AndroidManifest.xml` içine
  `<uses-permission android:name="android.permission.CAMERA" />`
- iOS: `ios/App/App/Info.plist` içine
  `NSCameraUsageDescription` = "Barkod okumak için kamera kullanılır."

iOS'ta canlı barkod okuma için ileride `@capacitor-mlkit/barcode-scanning` eklentisi eklenebilir.
