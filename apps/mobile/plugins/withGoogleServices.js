/**
 * Config plugin: wire the google-services gradle plugin into the native
 * project so `getDevicePushTokenAsync` can initialise Firebase (T0.15).
 *
 * Why a local plugin: as of SDK 54 `expo-notifications`' own plugin only
 * configures notification icon/color/channel — the old
 * `googleServicesFile: true` option is gone, and nothing else applies
 * `com.google.gms.google-services`. Found on hardware 2026-09-12: a
 * build without this registers no FCM token and the probe proves
 * nothing (see the T0.15 proof commit).
 *
 * `google-services.json` itself is NOT committed (apps/mobile/.gitignore)
 * — prebuild copies it from `apps/mobile/google-services.json`, which the
 * owner places per T0.15-RUNBOOK.md step 2.
 */
const { withProjectBuildGradle, withAppBuildGradle } = require('expo/config-plugins');

const CLASSPATH = "classpath('com.google.gms:google-services:4.4.2')";
const APPLY = 'apply plugin: "com.google.gms.google-services"';

function addClasspath(content) {
  if (content.includes('com.google.gms:google-services')) return content;
  // Inside the root buildscript dependencies block, after the kotlin
  // classpath line — the block the prebuild template generates.
  return content.replace(
    /(classpath\('org\.jetbrains\.kotlin:kotlin-gradle-plugin'\))/,
    `$1\n    ${CLASSPATH}`,
  );
}

function addApply(content) {
  if (content.includes('com.google.gms.google-services')) return content;
  // After the react plugin apply at the top of the app build file.
  return content.replace(
    /(apply plugin: "com\.facebook\.react")/,
    `$1\n${APPLY}`,
  );
}

module.exports = function withGoogleServices(config) {
  config = withProjectBuildGradle(config, (config) => {
    config.modResults.contents = addClasspath(config.modResults.contents);
    return config;
  });
  config = withAppBuildGradle(config, (config) => {
    config.modResults.contents = addApply(config.modResults.contents);
    return config;
  });
  return config;
};
