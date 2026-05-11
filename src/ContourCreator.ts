
import { MarchingSquaresModule } from './cpp/marchingsquares';
import { Grid } from "./Grid";
import { ContourData, TypedArray } from "./AutumnTypes";

interface InitMSModuleOpts {
    document_script?: string;
}

let msm_promise: Promise<MarchingSquaresModule> | null = null;

async function initMSModule(opts: InitMSModuleOpts) {
    // Only create Module once - cache the promise
    if (msm_promise !== null) {
        return msm_promise;
    }

    // Dynamically import to defer Module instantiation until first use
    const ModuleFactory = (await import('./cpp/marchingsquares')).default;
    
    const moduleConfig: any = {};
    if (opts.document_script !== undefined) {
        moduleConfig['locateFile'] = (fname: string, dir: string) => opts.document_script + fname;
    }

    msm_promise = ModuleFactory(moduleConfig).then(
        (mod: MarchingSquaresModule) => {
            return mod;
        },
        (err: any) => {
            msm_promise = null; // Clear on error to allow retry
            throw err;
        }
    );

    return msm_promise;
}

/** Options for contouring data via {@link RawScalarField.getContours | RawScalarField.getContours()} */
interface FieldContourOpts {
    /**
     * The interval at which to create contours. The field will be contoured at this interval from its minimum to its maximum.
     */
    interval?: number;

    /**
     * Contour the field at these specific levels.
     */
    levels?: number[];

    /**
     * Add triangles in the contouring, which takes longer and generates more detailed (not necessarily smoother or better) contours
     */
    quad_as_tri?: boolean;
}

async function contourCreator<ArrayType extends TypedArray>(data: ArrayType, grid: Grid, opts: FieldContourOpts) {
    if (opts.interval === undefined && opts.levels === undefined) {
        throw "Must supply either an interval or levels to contourCreator()"
    }

    const interval = opts.interval === undefined ? 0 : opts.interval;
    const quad_as_tri = opts.quad_as_tri === undefined ? false : opts.quad_as_tri;

    const msm = await initMSModule({});

    const grid_coords = grid.getGridCoords();

    const getContourLevels = data instanceof Float32Array ? msm.getContourLevelsFloat32 : msm.getContourLevelsFloat16;
    const makeContours = data instanceof Float32Array ? msm.makeContoursFloat32 : msm.makeContoursFloat16;

    const levels = opts.levels === undefined ? getContourLevels(data, grid.ni, grid.nj, interval) : opts.levels;
    const contours = makeContours(data, grid_coords.x, grid_coords.y, levels, (x: number, y: number) => grid.transform(x, y, {inverse: true}), quad_as_tri);

    return contours as ContourData;
}

export {contourCreator, initMSModule};
export type {FieldContourOpts};