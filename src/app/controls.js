import { catalogControlServices } from './catalog.js';
import { StyleManager } from '../ui/composition.js';
import { flyToLandmark } from '../locations.js';
import { initCockpitCloudEffects } from '../cockpitCloudEffects.js';

/** Construct the existing controls and camera presentation. */
export function createApplicationControls({
  scene: { viewer, mapStackController, operations },
  loaderStatus,
  Controls = StyleManager,
  services,
  catalog,
  placeSearch,
  defer,
}) {
  // Initialize the style manager (post-processing, HUD, locations, share links)
  const styleManager = new Controls(viewer, {
    services: {
      ...services,
      ...operations.surface.controlServices,
      searchAndFlyTo: operations.searchAndFlyTo,
      fetchRegionalBrief: (...args) =>
        operations.requests.regional.getBrief(...args),
      ...catalogControlServices(catalog),
    },
    requestServices: operations.requests,
    mapStackController,
    placeSearch,
  });
  defer(() => styleManager.orbitController.stop());
  defer(() => styleManager.hud.destroy());
  defer(() => styleManager.dispose());
  // The previous multi-canvas weather compositor remains disabled. Cockpit
  // clouds use a separate, capped low-resolution GPU pass that never attaches
  // Cesium fog or post-process stages and is fully stopped in map mode.
  const weatherEffects = null;
  const cockpitCloudEffects = initCockpitCloudEffects(viewer, {
    weatherService: operations.requests.weather,
  });
  defer(() => cockpitCloudEffects?.destroy());

  // If no share link state, open centered on the requested Quilmes address.
  if (!styleManager.hasShareState) {
    const startupController = new AbortController();
    loaderStatus.textContent = 'Flying to Lugones 24, Quilmes...';
    defer(() => {
      startupController.abort();
      if (!viewer.isDestroyed()) viewer.camera.cancelFlight();
    });
    void operations
      .searchAndFlyTo(
        viewer,
        'Lugones 24, Quilmes, Buenos Aires, Argentina',
        {
          placeSearch,
          signal: startupController.signal,
          forceClose: true,
          range: 220,
          duration: 4.0,
        },
      )
      .then((destination) => {
        if (startupController.signal.aborted || destination) return;
        loaderStatus.textContent = 'Opening Lugones, Quilmes...';
        flyToLandmark(viewer, -34.7386093, -58.2435432, {
          range: 220,
          pitch: -30,
          heading: 30,
          buildingHeight: 8,
          duration: 4.0,
        });
      })
      .catch((error) => {
        if (startupController.signal.aborted) return;
        console.warn('Startup location search failed:', error);
        loaderStatus.textContent = 'Opening Lugones, Quilmes...';
        flyToLandmark(viewer, -34.7386093, -58.2435432, {
          range: 220,
          pitch: -30,
          heading: 30,
          buildingHeight: 8,
          duration: 4.0,
        });
      });
  } else {
    loaderStatus.textContent = 'Restoring shared view...';
  }

  return { styleManager, weatherEffects, cockpitCloudEffects };
}
