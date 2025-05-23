
import { LineData, TypedArray, WebGLAnyRenderingContext} from './AutumnTypes';
import { LngLat, MapLikeType } from './Map';
import { PlotComponent, getGLFormatTypeAlignment } from './PlotComponent';
import { RawScalarField } from './RawField';
import { PolylineCollection } from './PolylineCollection';
import { TextCollection, TextCollectionOptions, TextSpec } from './TextCollection';
import { WGLTexture } from 'autumn-wgl';

import { hex2rgb, normalizeOptions } from './utils';
import { kdTree } from 'kd-tree-javascript';

interface ContourOptions {
    /** 
     * The color of the contours as a hex color string 
     * @default '#000000'
     */
    color?: string;

    /** 
     * The contour interval for drawing contours at regular intervals
     * @default 1
     */
    interval?: number;

    /**
     * A list of arbitrary levels (up to 40) to contour. This overrides the `interval` option.
     * @default Draw contours at regular intervals given by the `interval` option.
     */
    levels?: number[];
}

interface ContourGLElems<MapType extends MapLikeType> {
    gl: WebGLAnyRenderingContext;
    map: MapType;
}

/** 
 * A field of contoured data.
 * @example
 * // Create a contoured height field, with black contours every 30 m (assuming the height field is in 
 * // meters).
 * const contours = new Contour(height_field, {color: '#000000', interval: 30});
 */
class Contour<ArrayType extends TypedArray, MapType extends MapLikeType> extends PlotComponent<MapType> {
    private field: RawScalarField<ArrayType>;
    public readonly color: string;
    public readonly interval: number;
    public readonly levels: number[];

    private gl_elems: ContourGLElems<MapType> | null;
    private contours: PolylineCollection | null;

    /**
     * Create a contoured field
     * @param field - The field to contour
     * @param opts  - Options for creating the contours
     */
    constructor(field: RawScalarField<ArrayType>, opts: ContourOptions) {
        super();

        this.field = field;

        this.interval = opts.interval || 1;
        this.levels = opts.levels || [];

        this.color = opts.color || '#000000';

        this.gl_elems = null;
        this.contours = null;
    }

    /**
     * Update the data displayed as contours
     * @param field - The new field to contour
     */
    public async updateField(field: RawScalarField<ArrayType>) {
        this.field = field;
        if (this.gl_elems === null) return;

        const gl = this.gl_elems.gl;

        const contour_data = await this.getContours();
        const line_data = Object.values(contour_data).flat().map(c => {
            return {vertices: c} as LineData;
        });

        this.contours = await PolylineCollection.make(gl, line_data, {line_width: 2, color: this.color});
        this.gl_elems.map.triggerRepaint();
    }

    public async getContours() {
        return await this.field.getContours({interval: this.interval, levels: this.levels});
    }

    /**
     * @internal
     * Add the contours to a map
     */
    public async onAdd(map: MapType, gl: WebGLAnyRenderingContext) {

        this.gl_elems = {
            gl: gl, map: map
        };

        await this.updateField(this.field);
    }

    /**
     * @internal
     * Render the contours
     */
    public render(gl: WebGLAnyRenderingContext, matrix: number[] | Float32Array) {
        if (this.gl_elems === null || this.contours === null) return;
        const gl_elems = this.gl_elems;

        if (matrix instanceof Float32Array)
            matrix = [...matrix];

        const zoom = gl_elems.map.getZoom();
        const map_width = gl_elems.map.getCanvas().width;
        const map_height = gl_elems.map.getCanvas().height;
        const bearing = gl_elems.map.getBearing();
        const pitch = gl_elems.map.getPitch();

        this.contours.render(gl, matrix, [map_width, map_height], zoom, bearing, pitch);
    }
}

interface ContourLabelGLElems<MapType extends MapLikeType> {
    gl: WebGLAnyRenderingContext;
    map: MapType;
}

interface ContourLabelOptions {
    /**
     * Number of decimal places to use in the contour labels
     * @default 0
     */
    n_decimal_places?: number;

    /**
     * Font face to use for the contour labels
     * @default 'Trebuchet MS'
     */
    font_face?: string;

    /**
     * Font size in points to use for the contour labels
     * @default 12
     */
    font_size?: number;

    /**
     * URL template to use in retrieving the font data for the labels. The default is to use the template from the map style.
     */
    font_url_template?: string;

    /**
     * Text color for the contour labels
     * @default '#000000'
     */
    text_color?: string;

    /**
     * Halo (outline) color for the contour labels
     * @default '#000000'
     */
    halo_color?: string;

    /**
     * Whether to draw the halo (outline) on the contour labels
     * @default false
     */
    halo?: boolean;

    number_format?: Intl.NumberFormat;
}

const contour_label_opt_defaults: Required<ContourLabelOptions> = {
    n_decimal_places: 0,
    font_face: 'Trebuchet MS',
    font_size: 12,
    font_url_template: '',
    text_color: '#000000',
    halo_color: '#000000',
    halo: false,
    number_format: null
}

class ContourLabels<ArrayType extends TypedArray, MapType extends MapLikeType> extends PlotComponent<MapType> {
    private readonly contours: Contour<ArrayType, MapType>;
    private gl_elems: ContourLabelGLElems<MapType> | null;
    private text_collection: TextCollection | null;
    private readonly opts: Required<ContourLabelOptions>;

    constructor(contours: Contour<ArrayType, MapType>, opts?: ContourLabelOptions) {
        super();

        this.opts = normalizeOptions(opts, contour_label_opt_defaults);

        this.contours = contours;
        this.text_collection = null;
        this.gl_elems = null;
    }

    /**
     * Update contour labels when the field for the associated Contour object has been changed.
     */
    public async updateField() {
        if (this.gl_elems === null) return;

        const map = this.gl_elems.map;
        const gl = this.gl_elems.gl;

        const map_style = map.getStyle();

        const font_url_template = this.opts.font_url_template == '' ? map_style.glyphs : this.opts.font_url_template;
        const font_url = font_url_template.replace('{range}', '0-255').replace('{fontstack}', this.opts.font_face);

        const label_pos: TextSpec[] = [];

        const contour_data = await this.contours.getContours();
        const contour_levels = Object.keys(contour_data).map(parseFloat);
        contour_levels.sort((a, b) => a - b);

        const map_max_zoom = map.getMaxZoom();
        const contour_label_spacing = 0.01 * Math.pow(2, 7 - map_max_zoom);
        let min_label_lat: number = null, max_label_lat: number = null, min_label_lon: number = null, max_label_lon: number = null;

        Object.entries(contour_data).forEach(([level, contours]) => {
            const lvlF = parseFloat(level);
            const icntr = (lvlF - contour_levels[0]);
            const level_str = this.opts.number_format ? this.opts.number_format.format(lvlF) : level.toString();

            contours.forEach(contour => {
                const c_map = contour.map(v => {
                    const v_ll = new LngLat(...v).toMercatorCoord();
                    return [v_ll.x, v_ll.y] as [number, number];
                });
        
                const dist: number[] = [];
                c_map.forEach((v, i) => {
                    if (i == 0) {
                        dist.push(0);
                    }
                    else {
                        const v_last = c_map[i - 1];
                        const this_dist = Math.hypot(v_last[0] - v[0], v_last[1] - v[1]);
                        dist.push(dist[i - 1] + this_dist);
                    }
                });

                let n_labels_placed = 0;
                for (let idist = 1; idist < dist.length; idist++) {
                    const target_dist = contour_label_spacing * (n_labels_placed + (icntr / 2) % 1);
                    if (dist[idist - 1] <= target_dist && target_dist < dist[idist]) {
                        const pt1 = contour[idist - 1];
                        const pt2 = contour[idist];

                        const alpha = (target_dist - dist[idist - 1]) / (dist[idist] - dist[idist - 1]);
                        const pt_lon = (1 - alpha) * pt1[0] + alpha * pt2[0];
                        const pt_lat = (1 - alpha) * pt1[1] + alpha * pt2[1];

                        if (min_label_lon === null || pt_lon < min_label_lon) min_label_lon = pt_lon;
                        if (max_label_lon === null || pt_lon > max_label_lon) max_label_lon = pt_lon;
                        if (min_label_lat === null || pt_lat < min_label_lat) min_label_lat = pt_lat;
                        if (max_label_lat === null || pt_lat > max_label_lat) max_label_lat = pt_lat;

                        label_pos.push({lon: pt_lon, lat: pt_lat, min_zoom: map_max_zoom, text: level_str});
                        n_labels_placed++;
                    }
                }
            });
        });

        const tree = new kdTree(label_pos, (a, b) => Math.hypot(a.lon - b.lon, a.lat - b.lat), ['lon', 'lat']);

        const {x: min_label_x, y: max_label_y} = new LngLat(min_label_lon, min_label_lat).toMercatorCoord();
        const {x: max_label_x, y: min_label_y} = new LngLat(max_label_lon, max_label_lat).toMercatorCoord();
        const thin_grid_width = max_label_x - min_label_x;
        const thin_grid_height = max_label_y - min_label_y;
        const ni_thin_grid = Math.round(4 * thin_grid_width / contour_label_spacing);
        const nj_thin_grid = Math.round(4 * thin_grid_height / contour_label_spacing);
        const thin_grid_xs = [];
        const thin_grid_ys = [];

        for (let idx = 0; idx < ni_thin_grid; idx++) {
            thin_grid_xs.push(min_label_x + (idx / ni_thin_grid) * thin_grid_width);
        }

        for (let jdy = 0; jdy < nj_thin_grid; jdy++) {
            thin_grid_ys.push(min_label_y + (jdy / nj_thin_grid) * thin_grid_height);
        }

        let skip = 1;
        for (let zoom = map_max_zoom - 1; zoom >= 0; zoom--) {        
            for (let idx = 0; idx < ni_thin_grid; idx += skip) {
                for (let jdy = 0; jdy < nj_thin_grid; jdy += skip) {
                    const grid_x = thin_grid_xs[idx];
                    const grid_y = thin_grid_ys[jdy];
                    const ll = LngLat.fromMercatorCoord(grid_x, grid_y);

                    const [label, dist] = tree.nearest({lon: ll.lng, lat: ll.lat, min_zoom: 0, text: ""}, 1)[0];
                    label.min_zoom = zoom;
                }
            }

            skip *= 2;
        }

        const tc_opts: TextCollectionOptions = {
            horizontal_align: 'center', vertical_align: 'middle', font_size: this.opts.font_size,
            halo: this.opts.halo, 
            text_color: hex2rgb(this.opts.text_color), halo_color: hex2rgb(this.opts.halo_color),
        };

        this.text_collection = await TextCollection.make(gl, label_pos, font_url, tc_opts);
        map.triggerRepaint();
    }

    /** 
     * @internal 
     * Add the contour labels to a map
     */
    public async onAdd(map: MapType, gl: WebGLAnyRenderingContext) {
        this.gl_elems = {
            gl: gl, map: map,
        }

        this.updateField();
    }

    /** 
     * @internal 
     * Render the contour labels
     */
    public render(gl: WebGLAnyRenderingContext, matrix: number[]) {
        if (this.gl_elems === null || this.text_collection === null) return;
        const gl_elems = this.gl_elems;

        const map_width = gl_elems.map.getCanvas().width;
        const map_height = gl_elems.map.getCanvas().height;
        const map_zoom = gl_elems.map.getZoom();

        this.text_collection.render(gl, matrix, [map_width, map_height], map_zoom);
    }
}

export default Contour;
export {ContourLabels};
export type {ContourOptions, ContourLabelOptions};