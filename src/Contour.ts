
import { TypedArray, WebGLAnyRenderingContext} from './AutumnTypes';
import { MapType } from './Map';
import { PlotComponent, getGLFormatTypeAlignment } from './PlotComponent';
import { RawScalarField } from './RawField';
import { Cache, hex2rgba } from './utils';
import { WGLBuffer, WGLProgram, WGLTexture } from 'autumn-wgl';

import Module from './cpp/marchingsquares';
import { MarchingSquaresModule } from './cpp/marchingsquares';
import { LineString, Point } from './cpp/marchingsquares_embind';
import './cpp/marchingsquares.wasm';

let msm: MarchingSquaresModule | null = null;

const contour_vertex_shader_src = require('./glsl/contour_vertex.glsl');
const contour_fragment_shader_src = require('./glsl/contour_fragment.glsl');
const program_cache = new Cache((gl: WebGLAnyRenderingContext) => new WGLProgram(gl, contour_vertex_shader_src, contour_fragment_shader_src));

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

    /** 
     * A function to thin the contours based on zoom level. The function should take a zoom level and return a number `n` that means to only show every 
     * `n`th contour.
     * @default Don't thin the contours on any zoom level
     */
    thinner?: (zoom: number) => number;
}

interface ContourGLElems {
    map: MapType;
    program: WGLProgram;
    vertices: WGLBuffer;
    grid_cell_size: WGLBuffer;
    fill_texture: WGLTexture;
    texcoords: WGLBuffer;
}

/** 
 * A field of contoured data. The contours can optionally be thinned based on map zoom level.
 * @example
 * // Create a contoured height field, with black contours every 30 m (assuming the height field is in 
 * // meters) and only using every other contour when the map zoom level is less than 5.
 * const contours = new Contour(height_field, {color: '#000000', interval: 30, 
 *                                                  thinner: zoom => zoom < 5 ? 2 : 1});
 */
class Contour<ArrayType extends TypedArray> extends PlotComponent {
    private readonly field: RawScalarField<ArrayType>;
    public readonly color: [number, number, number];
    public readonly interval: number;
    public readonly levels: number[];
    public readonly thinner: (zoom: number) => number;

    private gl_elems: ContourGLElems | null;

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

        const color = hex2rgba(opts.color || '#000000');
        this.color = [color[0], color[1], color[2]];

        this.thinner = opts.thinner || (() => 1);

        this.gl_elems = null;
    }

    /**
     * @internal
     * Add the contours to a map
     */
    public async onAdd(map: MapType, gl: WebGLAnyRenderingContext) {
        // Basic procedure for these contours from https://www.shadertoy.com/view/lltBWM
        gl.getExtension("OES_standard_derivatives");

        if (msm === null) {
            msm = await Module();
        }

        console.time('make contours (wasm)');
        const grid_coords = this.field.grid.getGridCoords();

        const grid = new msm.FloatList();
        grid.resize(this.field.grid.ni * this.field.grid.nj, 0);
        this.field.data.forEach((v, i) => grid.set(i, v));

        const grid_x = new msm.FloatList();
        grid_x.resize(this.field.grid.ni, 0);
        grid_coords.x.forEach((v, i) => grid_x.set(i, v));

        const grid_y = new msm.FloatList();
        grid_y.resize(this.field.grid.nj, 0);
        grid_coords.y.forEach((v, i) => grid_y.set(i, v));

        const levels = [...this.levels];
        if (levels.length == 0) {
            const levels_cpp = msm.getContourLevelsFloat32(grid, this.field.grid.ni, this.field.grid.nj, this.interval);

            for (let ilvl = 0; ilvl < levels_cpp.size(); ilvl++) {
                levels.push(levels_cpp.get(ilvl));
            }

            levels_cpp.delete();
        }

        const contours: Record<number, [number, number][][]> = {};
        levels.forEach(v => {
            const contours_ = msm.makeContoursFloat32(grid, grid_x, grid_y, v);
            contours[v] = [];

            for (let icntr = 0; icntr < contours_.size(); icntr++) {
                const contour: LineString = contours_.get(icntr);

                contours[v].push([]);

                for (let ipt = 0; ipt < contour.point_list.size(); ipt++) {
                    const pt: Point = contour.point_list.get(ipt);
                    const [lon, lat] = this.field.grid.transform(pt.x, pt.y, {inverse: true});
                    contours[v][icntr].push([lon, lat]);
                }
            }

            contours_.delete();
        });

        console.log(contours);

        grid.delete();
        console.timeEnd('make contours (wasm)');
        
        const program = program_cache.getValue(gl);

        const {vertices: verts_buf, texcoords: tex_coords_buf, cellsize: cellsize_buf} = await this.field.grid.getWGLBuffers(gl);
        const vertices = verts_buf;
        const texcoords = tex_coords_buf;
        const grid_cell_size = cellsize_buf;

        const {format, type, row_alignment} = getGLFormatTypeAlignment(gl, this.field.isFloat16());

        const fill_image = {'format': format, 'type': type, 
            'width': this.field.grid.ni, 'height': this.field.grid.nj, 'image': this.field.getTextureData(),
            'mag_filter': gl.LINEAR, 'row_alignment': row_alignment,
        };

        const fill_texture = new WGLTexture(gl, fill_image);
        this.gl_elems = {
            map: map, program: program, vertices: vertices, texcoords: texcoords, grid_cell_size: grid_cell_size, fill_texture: fill_texture
        };
    }

    /**
     * @internal
     * Render the contours
     */
    public render(gl: WebGLAnyRenderingContext, matrix: number[]) {
        if (this.gl_elems === null) return;
        const gl_elems = this.gl_elems;

        const zoom = gl_elems.map.getZoom();
        const intv = this.thinner(zoom) * this.interval;
        const cutoff = 0.3 / intv;
        const step_size = [1 / this.field.grid.ni, 1 / this.field.grid.nj];
        const zoom_fac = Math.pow(2, zoom);

        let uniforms = {'u_contour_interval': intv, 'u_line_cutoff': cutoff, 'u_color': this.color, 'u_step_size': step_size, 'u_zoom_fac': zoom_fac,
                        'u_matrix': matrix, 'u_num_contours': 0, 'u_contour_levels': [0]};

        if (this.levels.length > 0) {
            uniforms = {...uniforms, 'u_num_contours': this.levels.length, 'u_contour_levels': this.levels}
        }

        gl_elems.program.use(
            {'a_pos': gl_elems.vertices, 'a_grid_cell_size': gl_elems.grid_cell_size, 'a_tex_coord': gl_elems.texcoords},
            uniforms,
            {'u_fill_sampler': gl_elems.fill_texture}
        );

        gl.enable(gl.BLEND);
        gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

        gl_elems.program.draw();
    }
}

export default Contour;
export type {ContourOptions};