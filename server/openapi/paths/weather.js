import { langParam, op } from '../helpers.js';

export function weatherPaths() {
  return {
    '/api/v1/weather': { get: op({ summary: 'Get weather data', tag: 'Weather', description: 'Returns `{ data: { provider, city, units, current, today, today_hours, forecast } }` or `{ data: null, reason }` when there is no weather: `reason` is `not_configured` (no provider set up, or the chosen one is incomplete - no coordinates, no API key) or `upstream_error` (a provider is set up but the request to it failed; the server logs the cause). `today` carries the calendar day at the weather location plus its high/low, `pop_max` (the highest chance of precipitation in percent that day, or null) and `rain_window` (`{ from, to }`: the first and the last hour, 0-23, with a chance of at least 40 %, or null). `today_hours` lists the hours of that local day as `{ hour, pop, mm }` (chance in percent or null, precipitation in mm); for `openweathermap` each 3-hour step stands for its three hours and the hours already past are missing. `forecast` holds the following days only. `provider` is `open-meteo` (icon fields are Lucide icon names, `desc` is a `wmo.<code>` i18n key) or `openweathermap` (legacy; icon fields are OWM icon codes, `desc` is localized text).' }) },
    '/api/v1/weather/geocode': {
      get: op({
        summary: 'Search a place for the weather location',
        tag: 'Weather',
        description: 'Looks up places by name through the Open-Meteo Geocoding API (server-side; only the name and the result language are sent). Returns `{ data: [{ name, admin1, admin2, country, country_code, latitude, longitude, timezone }] }` with up to 8 places, an empty list when nothing matches, or `{ data: null, reason: \'upstream_error\' }` when the request to the provider failed or timed out. A name shorter than 2 characters answers 400 with `reason: \'name_too_short\'`, one longer than 100 characters 400 with `reason: \'name_too_long\'`. Results are cached for 30 minutes per name and language.',
        params: [
          { name: 'name', in: 'query', required: true, schema: { type: 'string', minLength: 2, maxLength: 100 } },
          langParam(),
        ],
      }),
    },
    '/api/v1/weather/icon/{code}': {
      get: op({ summary: 'Get weather icon asset', tag: 'Weather', params: [{ name: 'code', in: 'path', required: true, schema: { type: 'string' } }] }),
    },
  };
}
