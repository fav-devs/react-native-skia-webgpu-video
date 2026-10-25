# Vérification de la migration Skia 3.8.0 / WebGPU 0.19.1 — 25 octobre 2026

Ce document liste ce qui a **réellement** été exécuté pour cette migration : **sur l'hôte seulement**, un Linux x86_64 sans Xcode ni appareil. Aucun build natif, aucun test sur iPhone, Pixel ou simulateur, aucune mesure. Les changements amont et les décisions sont dans l'[audit](upstream-audit.md).

## Hôte

| Contrôle | Résultat |
| --- | --- |
| `npm install --package-lock-only --ignore-scripts` | `package-lock.json` sur Skia 3.8.0 et WebGPU 0.19.1 ; un seul `react-native-webgpu-dawn@157.0.0`. npm 10.9.4 et 11.21.1 écrivent le même fichier |
| `npm install --ignore-scripts` | Pour les contrôles seulement : les cinq paquets binaires (`react-native-skia-graphite-*`, `react-native-webgpu-dawn`, environ 1 Go) remplacés par des paquets vides de même version via `overrides`. Ni ce `package.json` ni son lockfile ne sont commités |
| `apply-skia-canvas-patch.mjs` | Sur une 3.8.0 intacte : patch appliqué, puis « already applied » au second passage ; 3 fichiers, 8 éditions, empreintes de `skia-canvas-patch.json` vérifiées |
| Syntaxe des en-têtes patchés | **Passée pour Android arm64** : `clang++` du NDK 27.1.12297006, `--target=aarch64-linux-android28 -std=c++20 -fsyntax-only -Wall`, sur `api/JsiSkSurface.h` et `api/JsiSkApi.h` (qui incluent `RNDawnContext.h`) avec les en-têtes Graphite/Dawn m157 du paquet et JSI de React Native 0.86.2, plus des références à `JsiSkApi::__rnskvGpuGeneration`, `JsiSkApi::__rnskvTrimRecorderCache`, `DawnContext::submitRecordingChecked` et `JsiSkSurface::enableCheckedSubmissions`. Aucune erreur |
| `test-skia-patch-syntax.mjs` (simulateur iOS, `xcrun`) | **Non exécuté** : pas de SDK Apple sur l'hôte. La syntaxe Objective-C++ pour iOS n'est pas vérifiée |
| Jest | **260/260 tests, 11 suites** (238 avant la migration, dont aucun retiré) |
| `tsc --noEmit` | OK |
| `test:package` | 5/5 |
| `benchmark:test` | 121 réussis, 1 ignoré (« sync fixtures not generated »), 0 échec |
| `bob build`, `publint --strict` | OK, « All good! » |
| `test:native` (`test-native.mjs`), `test-jvm-host.mjs` | **Non exécutés** : refusés par l'environnement. `test-skia-provider-ownership.mjs`, appelé par `test-native.mjs`, ne l'a pas été non plus. Aucun fichier C++, Objective-C++ ou Java de la bibliothèque ne change |

Tests ajoutés (22) :
- `gpuDevice.test.ts` : import sur premier usage, à nouveau après un remplacement, jamais pendant la perte, jamais de `destroy()` ; erreur claire sans le patch ; renégociation Android à chaque résolution de `Skia.gpu.lost`, et configuration gardée avec un avertissement si elle échoue.
- `gpu.test.ts` : nouvel import, portée d'un device remplacé (refus, `drain()` rejeté, `dispose()` sans attente), fence rejetée par une perte.
- `frameInterop.test.ts` : abandon sans drain des images, de la texture de travail, des baux retenus et des imports de buffers Android ; image en pause importée à nouveau au lieu de l'image perdue.
- `hooks.test.tsx` (dont un passage par le runtime UI sérialisé) : attente pendant la perte, surface refaite sans drain, seek d'un lecteur en pause, pas de seek en lecture, erreur due à la perte non signalée, quarantaine libérée, démontage après remplacement sans drain, `useVideoPlayback`.
- `export.test.ts`, `exportGpuAndroid.test.ts` : échec avec le message dédié et sa cause, aucune frame encodée après la perte, fichier non fini, libération sans drain et sans quarantaine, export suivant possible, session en quarantaine libérée après remplacement, dernière frame de la fenêtre Android non attendue.

Ces tests simulent Skia, WebGPU et la génération ; ils ne prouvent ni le comportement de Dawn à la perte, ni la sérialisation réelle des objets natifs entre runtimes Worklets.

## Natif

- **iOS :** `pod install` non exécuté (pas de CocoaPods). `example/ios/Podfile.lock` porte les nouvelles versions de pods, mais ses `SPEC CHECKSUMS` de `react-native-skia` et `react-native-webgpu` sont ceux de la 3.7.4 / 0.19.0 : à régénérer par `pod install`. Aucun build.
- **Android :** aucun build Gradle, aucun test instrumenté.
- **Appareils, simulateurs, benchmarks :** rien n'a tourné. Les mesures de la [vérification 3.7.4](../skia-3.7.4/verification.md) restent la référence ; aucun code de rendu ou d'export par frame ne change hors des contrôles de génération (un appel natif par frame et par hook, quelques-uns par import).

## Reste à faire

- Builds Release iOS et Android, tests natifs (`npm run test:native`, tests JVM), tests instrumentés Android, profil `smoke` sur iPhone 15 Pro et Pixel 8a, contrôle `interop` du Pixel (WebGPU change).
- **Perte réelle du device**, sur les deux plateformes :
  - forcer la perte avec `getVideoGpuDevice().forceLossForTesting()` (méthode de React Native WebGPU, non typée ; ne pas utiliser `destroy()`, que Skia ne traite pas comme une perte) pendant une lecture en pause, une lecture en cours et un export ;
  - iOS : passer l'app en arrière-plan pendant un export, puis revenir ;
  - attendus : l'aperçu reprend seul après le remplacement, l'image d'un lecteur en pause revient, l'export rejette avec `Video export failed: the GPU device was lost`, l'export suivant réussit, les réservations suivies reviennent à zéro.
- Android : vérifier que l'export sur la fenêtre de l'encodeur ferme son contexte avant que Skia ne détruise le device remplacé (voir [UPSTREAM_NOTES](../../docs/UPSTREAM_NOTES.md#perte-du-device-gpu--25-octobre-2026)).
- Mesurer le coût de `__rnskvGpuGeneration` par frame (attendu négligeable) dans un profil de lecture à 120 Hz.
