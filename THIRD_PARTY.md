# Third-party notices — RoadWise

## Linked dependencies

| Package | Licence |
|---|---|
| `androidx.camera:*` 1.6.0 (linked by `expo-camera`) | Apache-2.0 |
| `com.google.android.gms:play-services-location` 21.3.0 (linked by `modules/drive-sense`) | Android Software Development Kit License (Google Play Services terms) |
| `ExpoModulesCore` | MIT |

## MIT licence text (applies to the MIT-licensed dependencies)

```
MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Map data

Speed-limit data comes from two open sources, loaded by `supabase/data` (see its README):

- **OpenStreetMap.** Map data © OpenStreetMap contributors, available under the Open Database
  License 1.0 (https://opendatacommons.org/licenses/odbl/1-0/; https://www.openstreetmap.org/copyright).
  Extracts from Geofabrik (https://download.geofabrik.de/). The app shows the attribution
  "© OpenStreetMap contributors"; the `osm.ways` table and the tiles served from it are a derivative
  database subject to the ODbL's attribution and share-alike terms.
- **HPMS.** Highway Performance Monitoring System (HPMS) 2024, Federal Highway Administration (FHWA),
  distributed by the Bureau of Transportation Statistics (BTS) in the National Transportation Atlas
  Database (https://geodata.bts.gov/datasets/5e6a977c2d7c4ec1bdc82e684d3384f2). A work of the U.S.
  Government (17 U.S.C. § 105), not protected by copyright and available for unrestricted public use;
  acknowledgement requested: "Federal Highway Administration (FHWA) and Bureau of Transportation
  Statistics (BTS)".
