# Audit Skia 3.7.4 → 3.8.0 / WebGPU 0.19.0 → 0.19.1 — 25 octobre 2026

Audit des **archives npm publiées**, comparées fichier par fichier (`npm pack`, dossiers `src/`, `cpp/`, `android/`, `apple/`), puis migration du dépôt. Les contrôles exécutés sont dans [verification.md](verification.md).

## Versions retenues

**`react-native-skia@3.8.0` + `react-native-webgpu@0.19.1`**, toujours sur Graphite **157.0.0** et **`react-native-webgpu-dawn@157.0.0`** : aucun binaire Skia ni Dawn ne change.

| Paquet | Version | Publiée |
| --- | --- | --- |
| Skia | 3.8.0 | 24 oct., 13:51 UTC |
| WebGPU | 0.19.1 | 24 oct., 12:33 UTC |

Les dépendances pair ne bougent pas : Skia demande toujours `react >=19.0`, `react-native >=0.79`, `react-native-worklets >=0.7.0`, `react-native-reanimated >=4.0.0` ; WebGPU `react-native >=0.81.0`, `react-native-worklets >=0.7.2`, `react-native-reanimated >=4.2.1`. Les versions épinglées de la bibliothèque (RN 0.86.2, Reanimated 4.5.3, Worklets 0.11.3) y entrent.

## Changements Skia 3.8.0

La 3.8.0 est une version de **renommage** : 6 en-têtes C++ et les sources JS correspondantes changent, rien d'autre.

| Changement | Dans ce dépôt |
| --- | --- |
| `Skia.Image.MakeImageFromGPUTexture` → `MakeFromGPUTexture` | **Utilisé** : [gpu.ts](../../src/gpu.ts), [exportFrames.ts](../../src/exportFrames.ts) et les tests |
| `Skia.Image.MakeRasterImage` → `MakeRaster` | **Utilisé** : chemin raster iOS de [frameInterop.ts](../../src/frameInterop.ts) et les tests |
| `Skia.Image.MakeImageFromEncoded` → `MakeFromEncoded`, `MakeImageFromNativeBuffer` → `MakeFromNativeBuffer` | Non utilisés |
| `ColorFilter.MakeLumaColorFilter` → `MakeLuma`, `Picture.MakePicture` → `Make`, `Typeface.MakeFreeTypeFaceFromData` → `MakeFromData`, `AnimatedImage.MakeAnimatedImageFromEncoded` → `MakeFromEncoded` | Non utilisés |
| `SkiaPictureView` retiré (JS, mock, commentaires natifs) | Non utilisé, ni par l'exemple |
| Commentaire de `JsiSkSurfaceFactory.h` ; fichiers web | Sans effet |

Les noms ne sont pas gardés en alias : un appel à l'ancien nom échoue. Les autres points de la liste fournie avec la demande précèdent la 3.8.0 et étaient déjà dans la 3.7.4 : `encodeToBytes` / `encodeToBase64` lèvent une erreur au lieu de rendre `null` (3.7.3), et le `JsiRecorder` expose `makePicture` / `getSharedValues`. La bibliothèque n'utilise ni l'un ni l'autre.

**Fichiers du patch.** `RNDawnContext.h`, `JsiSkSurface.h` et `JsiSkApi.h` sont identiques octet pour octet à ceux de la 3.7.4 (empreintes `7381d2c9…`, `24797c70…`, `72c8c682…`), comme `RNSkGraphite*`, `RNSkManager*`, `RNSkWindowSurface*` et `RNImageProvider.h`. Le travail sur la perte du device décrit plus bas est arrivé en **3.7.3** ; la 3.7.4 l'avait déjà.

## Changements WebGPU 0.19.1

Un seul fichier change hors `package.json` : `ViewSnapshot.java` met le `HardwareRenderer` des instantanés de vue Android en non opaque (pixels transparents indéfinis sur Mali). La bibliothèque n'en fait pas. Aucune raison de rester en 0.19.0 ; les sources C++ et JS sont identiques.

## Ce qui motive la migration : le remplacement d'un device perdu

Depuis la 3.7.3, `DawnContext` remplace un device perdu (réinitialisation du pilote, GPU à court de mémoire, travail GPU refusé en arrière-plan sur iOS) par un nouveau device sur le même adaptateur, avec un nouveau contexte Graphite, que le code amont appelle une **génération**. `Skia.gpu.lost` se résout une fois le remplacement tenté, `useGpu()` fait un nouveau rendu. Tout ce qui a été fait sur le device perdu reste valide en mémoire mais ne dessine plus rien : recorders, surfaces hors écran, images de texture, `MakeFromGPUTexture`, et le device rendu par `Skia.getNativeDevice()`, qu'un code WebGPU doit importer à nouveau. Le device remplaçant est validé : une ressource de l'ancien qui lui parvient est refusée.

La bibliothèque importait le device une fois, au chargement de `gpuDevice.ts` sur le runtime RN, et les worklets capturaient cet import. Après une perte, l'aperçu restait vide jusqu'au redémarrage de l'app, et un export continuait sur un device mort.

### Lecture de la génération : un ajout au patch

`Skia.gpu` ne peut pas servir hors du runtime RN : `JsiSkApi` n'a qu'une promesse `lost` par instance, créée sur le runtime qui lit `Skia.gpu` le premier et résolue sur le runtime RN (`runOnJavascriptThread`) ; une lecture depuis le runtime UI ou d'export rendrait ou garderait une valeur JSI d'un autre runtime. Pendant la perte elle-même, avant le remplacement, rien côté JS ne l'indique : la promesse ne se résout qu'après la tentative de remplacement.

Le patch ajoute donc à `JsiSkApi.h` une méthode privée `__rnskvGpuGeneration()` : `DawnContext::generation()`, négative quand `DawnContext::isCurrent()` est faux (device perdu, pas encore remplacé), `0` sans GPU. C'est un nombre, lisible sur n'importe quel runtime et à chaque frame. Sans patch, comparer le pointeur rendu par `Skia.getNativeDevice()` suffirait à voir un remplacement (les générations ne sont jamais détruites, leur handle non plus), mais pas la perte avant remplacement, celle qui compte en arrière-plan sur iOS.

### Ce que la bibliothèque reconstruit, et où

| Objet | Avant | Maintenant |
| --- | --- | --- |
| `GPUDevice` | Importé une fois sur le runtime RN, capturé par les worklets | Importé sur chaque runtime (RN, UI, export) par l'objet `RNWebGPU` capturé, une fois par génération ([gpuDevice.ts](../../src/gpuDevice.ts)) |
| Blit YUV : layout, pipelines, sampler, module, uniformes NV12 | Un par runtime | Refait quand le device du runtime change ([yuvBlit.ts](../../src/yuvBlit.ts)) |
| Cache d'import des frames : texture de travail, vue Skia, snapshots, imports de buffers décodeur, baux retenus après un drain échoué | Un par runtime | Abandonné sans drain quand la génération change, puis refait ([frameInterop.ts](../../src/frameInterop.ts)) |
| Surface et images des aperçus | Par hook | Libérées sans drain et refaites ; un lecteur en pause revient à son temps courant pour décoder à nouveau son image ([videoCompositionPlayer.ts](../../src/videoCompositionPlayer.ts), [videoPlayer.ts](../../src/videoPlayer.ts)) |
| Quarantaine des aperçus | Jusqu'à la fin du runtime | Libérée quand son device a été perdu ou remplacé ([previewLifecycle.ts](../../src/previewLifecycle.ts)) |
| Session d'export (surfaces, fenêtre Android, cibles iOS, imports, réservations) | Quarantaine si un drain échoue | Échec dès la frame qui suit la perte, libération sans drain ; une session déjà en quarantaine part une fois son device remplacé ([exportVideoComposition.ts](../../src/exportVideoComposition.ts), [exportFrames.ts](../../src/exportFrames.ts)) |
| Portée GPU (`createVideoGpuScope`) | Liée au device importé | Toujours liée à son device ; refuse de nouvelles ressources, `drain()` rejette, `dispose()` n'attend plus le device perdu ([gpu.ts](../../src/gpu.ts)) |
| Interop AHardwareBuffer Android | Négociée une fois au chargement | Renégociée sur le runtime RN à chaque résolution de `Skia.gpu.lost` |

Pourquoi un import par runtime plutôt qu'un import RN partagé : les valeurs capturées par un worklet le sont à sa création ; un nouvel import sur le runtime RN n'atteindrait pas les runtimes UI et d'export sans canal partagé, et ce canal ne servirait qu'à transporter un `GPUDevice` que chaque runtime sait importer lui-même. Les opérations asynchrones de WebGPU 0.19 (`onSubmittedWorkDone`, `mapAsync`) prennent déjà le contexte du runtime appelant ; seul `device.lost` est propre au runtime RN, et la bibliothèque ne s'en sert pas.

Pourquoi abandonner sans drain : sur un device perdu, un flush vérifié lève une erreur (recorder d'une autre génération, ou device perdu), et `onSubmittedWorkDone` ne prouve rien. Rien de ce qui a été soumis ne peut encore s'exécuter : Dawn a considéré le travail terminé, et Skia détruit le device remplacé. Rendre un bail décodeur à ce moment ne laisse pas le GPU lire un buffer réécrit.

### Exports

- La génération est lue avant toute allocation ; un device déjà perdu fait échouer l'export aussitôt.
- Avant chaque frame et avant `finishWriting`, un device perdu ou remplacé fait échouer l'export avec un message dédié (`Video export failed: the GPU device was lost …`), la cause native éventuelle dans `error.cause`. L'export s'arrête à la frame qui suit la perte et ne finit pas le fichier.
- Le patch contrôle aussi la perte **après** l'attente d'une soumission vérifiée synchrone (`submitRecordingChecked`) : une attente qui se termine sur un device perdu n'a pas exécuté la recording. Sans ce contrôle, la dernière frame d'un export iOS ou readback pourrait passer pour dessinée.
- Sur la fenêtre Android, la dernière frame est présentée avant son attente vérifiée (attente différée de la 3.7.4) : si la perte survient après `finishWriting`, l'export échoue quand même.
- La session est libérée sans drain, le runtime d'export reste utilisable : l'export suivant tourne sur le nouveau device.

### Côté natif de la bibliothèque

Ni iOS ni Android ne gardent de `WGPUDevice` ou d'objet Dawn : les buffers natifs passent par `RNWebGPU.createVideoFrameFromNativeBuffer` côté JS. Rien à changer. `NativeHardwareBuffer::configure()` accepte d'être rappelé (activer sonde EGL/AHB si besoin, désactiver est immédiat) : la renégociation passe par lui. Les décodeurs déjà ouverts gardent leur transport.

### Décisions

- **Un export en cours échoue** plutôt que de reprendre sur le nouveau device : ses images décodées, sa cible et ses frames déjà soumises appartiennent au device perdu, et reprendre exigerait de redécoder depuis la dernière frame sûre.
- **Pas de nouvelle API publique.** Les applications qui utilisent une portée GPU comparent `scope.device` à `getVideoGpuDevice()`, tous deux déjà publics. `getVideoGpuState()` reste interne.
- **Un lecteur en pause est replacé à son temps courant** (`seekTo`), depuis le runtime RN : ses frames décodées sont parties avec le device, et iOS a déjà rendu leurs buffers. Ce seek est celui du hook : `useVideoPlayback` ne le signale pas à `onSeekComplete` (un écouteur posé avec `player.on("seekComplete")` le reçoit encore). Un lecteur en lecture n'est pas replacé : il dessine les frames suivantes, et un seek en lecture 4K sur Pixel 8a peut bloquer l'horloge (problème connu).

## Le patch local

Toujours **3 fichiers et 8 éditions** ([`skia-canvas-patch.json`](../../scripts/skia-canvas-patch.json), [`react-native-skia+3.8.0.patch`](../../patches/react-native-skia+3.8.0.patch)) ; les empreintes « avant » sont celles de la 3.7.4.

| Partie | 3.7.4 | 3.8.0 | Encore nécessaire en amont ? |
| --- | --- | --- | --- |
| `submitRecordingChecked` (`RNDawnContext.h`) | 1 édition | **Étendue** : contrôle de perte après une attente synchrone | Oui : `submitRecording` renvoie toujours `false` et `flush()` l'ignore |
| Surfaces vérifiées : `enableCheckedSubmissions`, `flush`, `makeImageSnapshot` nul (`JsiSkSurface.h`) | 5 éditions | Inchangées | Oui : `JsiSkSurface.h` est identique à la 3.7.4 |
| `__rnskvTrimRecorderCache` (`JsiSkApi.h`) | 2 éditions | **Étendues** : `__rnskvGpuGeneration` ajoutée à côté | Oui pour la réduction ; la génération n'a pas d'équivalent amont lisible hors du runtime RN |

Empreintes « après » : `RNDawnContext.h` `6241bfd1…`, `JsiSkSurface.h` `4c8ab5d0…` (inchangée), `JsiSkApi.h` `8d2d5ccc…`.

**PR amont.** L'état de [#4274](https://github.com/wcandillon/react-native-skia/pull/4274) et [#4276](https://github.com/wcandillon/react-native-skia/pull/4276) n'a pas été revu pour cette migration (pas d'accès à l'API GitHub de ce dépôt depuis l'environnement). Deux propositions nouvelles : une génération lisible sur tout runtime (ou un `lost` par runtime), et la prise en compte par `destroyRetiredDevice` des surfaces que React Native WebGPU a configurées sur le device remplacé (voir [UPSTREAM_NOTES](../../docs/UPSTREAM_NOTES.md#perte-du-device-gpu--25-octobre-2026)).
