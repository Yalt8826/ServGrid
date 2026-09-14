/**
 * The location console's map — WEB implementation (T4.10,
 * UI/plan-2/07-OWNER.md §O3). MapLibre GL JS with a RASTER tile source,
 * avoiding a Mapbox token for a one-user surface; this is the only map
 * in the system, and Metro bundles this module for web alone.
 *
 * THE TILE SOURCE IS AN OPEN OWNER DECISION (`PLAN-FRONTEND.md` open
 * item 2: self-hosted raster vs a free tier with attribution
 * obligations). This file does not improvise one: it reads the style
 * URL from `EXPO_PUBLIC_MAP_STYLE_URL`, and while that is unset it
 * renders an honest placeholder instead of a map — the roster next to
 * it still answers "is tracking actually working", which is the part
 * that survives descoping. Dropping the decision in is a one-line env
 * var, not a code change.
 *
 * Dots: current positions, one HTML marker each — MOVED (not rebuilt)
 * when a fix arrives, so a locate-now fulfilment shows the dot move.
 * Trail: the selected employee's day as a GeoJSON line with time labels
 * at DIRECTION CHANGES ONLY (`trailStops` in `locationModel.ts` — a
 * label at every point is noise). The trail draws ONCE on selection,
 * 400ms, left to right — a path through time drawn in time order is
 * information, not decoration (§O3 Motion); the draw walks the classic
 * line-dasharray sequence and then stops, re-armed only by the next
 * selection.
 *
 * The selected dot's pulse is the same bounded exception as everywhere
 * else on this screen: the marker's element carries the pulse class
 * exactly while `pulseActive` — `focused && liveWindowOpen` — and the
 * class coming off STOPS the animation rather than pausing it.
 */
import { useEffect, useRef } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import './location-map.css';

import { SEMANTIC } from '@servgrid/shared';
import { textStyle } from '../../fonts/textStyle';
import type { TrailStop } from './locationModel';
import type { LocationMapProps } from './locationMap';

export const MAP_UNCONFIGURED_MESSAGE =
  'Map not rendered — no tile source configured yet. The tile source is an owner decision (self-hosted vs a free attribution tier); the roster still answers "is tracking working".';

/** The trail's draw-once duration (§O3 Motion: 400ms, left to right). */
const TRAIL_DRAW_MS = 400;

/** The dash sequence that walks a line in: [drawn, gap] pairs growing
 * the drawn fraction from nothing to the whole path. */
function dashSequenceFor(pointCount: number): number[][] {
  const steps = Math.max(2, Math.min(24, pointCount));
  const seq: number[][] = [[0, 1e5]];
  for (let i = 1; i <= steps; i += 1) {
    const drawn = (i / steps) * 1e5;
    seq.push([drawn, 1e5 - drawn]);
  }
  return seq;
}

/** Structural shapes for the trail source — typed locally because
 * `@types/geojson` is not a workspace dependency and the global
 * GeoJSON namespace must not be assumed. */
interface LineCollection {
  type: 'FeatureCollection';
  features: Array<{
    type: 'Feature';
    properties: Record<string, never>;
    geometry: { type: 'LineString'; coordinates: Array<[number, number]> };
  }>;
}

function trailFeatureCollection(stops: TrailStop[]): LineCollection {
  return {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: {},
        geometry: { type: 'LineString', coordinates: stops.map((s) => [s.longitude, s.latitude]) },
      },
    ],
  };
}

const EMPTY_COLLECTION: LineCollection = {
  type: 'FeatureCollection',
  features: [],
};

export function LocationMap({
  rows,
  selectedEmployeeId,
  trailStops,
  pulseActive,
}: LocationMapProps): React.ReactNode {
  const styleUrl = process.env.EXPO_PUBLIC_MAP_STYLE_URL;
  const configured = typeof styleUrl === 'string' && styleUrl.length > 0;

  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const dotsRef = useRef(new Map<string, maplibregl.Marker>());
  const trailSourceRef = useRef<maplibregl.GeoJSONSource | null>(null);
  const stopMarkersRef = useRef<maplibregl.Marker[]>([]);
  const drawTimerRef = useRef<number | null>(null);
  const didFitRef = useRef(false);

  // The map object itself — created once, destroyed on unmount.
  useEffect(() => {
    if (!configured || containerRef.current === null || mapRef.current !== null) return;
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: styleUrl as string,
      attributionControl: { compact: true }, // an attribution obligation is the owner's call, honoured once made
    });
    map.on('load', () => {
      map.addSource('trail', { type: 'geojson', data: EMPTY_COLLECTION });
      map.addLayer({
        id: 'trail-line',
        type: 'line',
        source: 'trail',
        paint: { 'line-color': SEMANTIC.text.primary, 'line-width': 2, 'line-dasharray': [0, 1e5] },
      });
      trailSourceRef.current = map.getSource('trail') as maplibregl.GeoJSONSource;
    });
    mapRef.current = map;
    return () => {
      if (drawTimerRef.current !== null) window.clearInterval(drawTimerRef.current);
      for (const marker of dotsRef.current.values()) marker.remove();
      dotsRef.current.clear();
      for (const marker of stopMarkersRef.current) marker.remove();
      stopMarkersRef.current = [];
      map.remove();
      mapRef.current = null;
      trailSourceRef.current = null;
      didFitRef.current = false;
    };
  }, [configured, styleUrl]);

  // Current positions as dots. First fill fits the camera once, so the
  // owner opens on his fleet rather than on the dateline.
  useEffect(() => {
    const map = mapRef.current;
    if (!configured || map === null) return;
    const positions: Array<[number, number]> = [];
    const seen = new Set<string>();
    for (const row of rows) {
      if (row.position === null) continue;
      seen.add(row.employeeId);
      const coords: [number, number] = [row.position.longitude, row.position.latitude];
      positions.push(coords);
      const existing = dotsRef.current.get(row.employeeId);
      if (existing !== undefined) {
        existing.setLngLat(coords);
        continue;
      }
      const el = document.createElement('div');
      el.style.width = '12px';
      el.style.height = '12px';
      el.style.borderRadius = '6px';
      el.style.backgroundColor = SEMANTIC.text.primary;
      el.style.border = '2px solid #FFFFFF';
      el.style.boxSizing = 'border-box';
      dotsRef.current.set(row.employeeId, new maplibregl.Marker({ element: el }).setLngLat(coords).addTo(map));
    }
    for (const [id, marker] of dotsRef.current) {
      if (!seen.has(id)) {
        marker.remove();
        dotsRef.current.delete(id);
      }
    }
    if (!didFitRef.current && positions.length > 0) {
      const lngs = positions.map((p) => p[0]);
      const lats = positions.map((p) => p[1]);
      map.fitBounds(
        [
          [Math.min(...lngs), Math.min(...lats)],
          [Math.max(...lngs), Math.max(...lats)],
        ],
        { padding: 48, maxZoom: 14, duration: 0 },
      );
      didFitRef.current = true;
    }
  }, [configured, rows]);

  // The selected dot's pulse — the class is the switch; removing it
  // cancels the CSS animation. Nothing here runs on its own clock.
  useEffect(() => {
    const marker = selectedEmployeeId === null ? undefined : dotsRef.current.get(selectedEmployeeId);
    const el = marker?.getElement();
    if (el === undefined) return;
    if (pulseActive) el.classList.add('location-dot-pulse');
    else el.classList.remove('location-dot-pulse');
  }, [configured, pulseActive, rows, selectedEmployeeId]);

  // The day trail: geometry + direction-change labels + the draw-once
  // 400ms walk. Re-armed only when the selection (or its trail) changes.
  useEffect(() => {
    const map = mapRef.current;
    const source = trailSourceRef.current;
    if (!configured || map === null || source === null) return;
    if (selectedEmployeeId === null || trailStops.length < 2) {
      source.setData(EMPTY_COLLECTION);
      for (const marker of stopMarkersRef.current) marker.remove();
      stopMarkersRef.current = [];
      return;
    }
    source.setData(trailFeatureCollection(trailStops));

    for (const marker of stopMarkersRef.current) marker.remove();
    stopMarkersRef.current = trailStops.map((stop) => {
      const el = document.createElement('div');
      el.style.padding = '1px 4px';
      el.style.backgroundColor = 'rgba(255,255,255,0.92)';
      el.style.border = `1px solid ${SEMANTIC.line.strong}`;
      el.style.fontSize = '11px';
      el.style.fontFamily = 'IBM Plex Sans, sans-serif';
      el.textContent = stop.label;
      return new maplibregl.Marker({ element: el }).setLngLat([stop.longitude, stop.latitude]).addTo(map);
    });

    if (drawTimerRef.current !== null) window.clearInterval(drawTimerRef.current);
    const sequence = dashSequenceFor(trailStops.length);
    map.setPaintProperty('trail-line', 'line-dasharray', sequence[0]!);
    let step = 0;
    drawTimerRef.current = window.setInterval(() => {
      step += 1;
      map.setPaintProperty('trail-line', 'line-dasharray', sequence[Math.min(step, sequence.length - 1)]!);
      if (step >= sequence.length - 1 && drawTimerRef.current !== null) {
        window.clearInterval(drawTimerRef.current);
        drawTimerRef.current = null;
      }
    }, Math.ceil(TRAIL_DRAW_MS / sequence.length));
    return () => {
      if (drawTimerRef.current !== null) {
        window.clearInterval(drawTimerRef.current);
        drawTimerRef.current = null;
      }
    };
  }, [configured, selectedEmployeeId, trailStops]);

  if (!configured) {
    // The honest empty state — no improvised tile provider, no broken
    // map frame pretending to be one refresh away from working.
    return (
      <View style={styles.placeholder} testID="location-map-unconfigured">
        <Text style={styles.placeholderText}>{MAP_UNCONFIGURED_MESSAGE}</Text>
      </View>
    );
  }
  return (
    <View
      style={styles.container}
      testID="location-map"
      ref={(instance: unknown) => {
        containerRef.current = instance === null ? null : (instance as HTMLDivElement);
      }}
    />
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  placeholder: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
    backgroundColor: SEMANTIC.bg.dense,
  },
  placeholderText: { ...textStyle('body'), color: SEMANTIC.text.secondary, textAlign: 'center' },
});
