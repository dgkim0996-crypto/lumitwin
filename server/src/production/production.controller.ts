import { Controller, DefaultValuePipe, Get, Param, ParseIntPipe, Query } from '@nestjs/common';
import { ProductionService } from './production.service';
import { ProductionWriter } from './production.writer';

const optInt = (v?: string) => (v == null || v === '' ? undefined : Number.parseInt(v, 10) || undefined);

@Controller('production')
export class ProductionController {
  constructor(
    private readonly production: ProductionService,
    private readonly writer: ProductionWriter,
  ) {}

  @Get('runs')
  runs() {
    return this.production.runs();
  }

  @Get('writer')
  writerStats() {
    return this.writer.stats;
  }

  @Get('trace/:serial')
  trace(@Param('serial') serial: string, @Query('run') run?: string) {
    return this.production.trace(serial, optInt(run));
  }

  @Get('ancestors/:serial')
  ancestors(@Param('serial') serial: string, @Query('run') run?: string) {
    return this.production.ancestors(serial, optInt(run));
  }

  @Get('lots')
  lots(@Query('material') material?: string, @Query('run') run?: string) {
    return this.production.lots(material, optInt(run));
  }

  @Get('lot-quality')
  lotQuality(@Query('material') material?: string, @Query('run') run?: string) {
    return this.production.lotQuality(material, optInt(run));
  }

  @Get('factors/:station')
  factors(@Param('station') station: string, @Query('defect') defect?: string, @Query('run') run?: string) {
    return this.production.factors(station, defect || undefined, optInt(run));
  }

  @Get('lots/:lot')
  lot(@Param('lot') lot: string, @Query('run') run?: string) {
    return this.production.lot(lot, optInt(run));
  }

  @Get('records')
  records(
    @Query('station') station: string,
    @Query('limit', new DefaultValuePipe(50), ParseIntPipe) limit: number,
    @Query('result') result?: 'OK' | 'NG',
    @Query('run') run?: string,
  ) {
    return this.production.records(station, limit, result === 'OK' || result === 'NG' ? result : undefined, optInt(run));
  }

  @Get('units')
  units(
    @Query('line') line?: string,
    @Query('status') status?: string,
    @Query('limit', new DefaultValuePipe(50), ParseIntPipe) limit = 50,
    @Query('run') run?: string,
  ) {
    return this.production.units(line, status, limit, optInt(run));
  }

  @Get('hourly/:line')
  hourly(@Param('line') line: string, @Query('run') run?: string) {
    return this.production.hourly(line, optInt(run));
  }

  @Get('defects')
  defects(@Query('line') line?: string, @Query('run') run?: string) {
    return this.production.defects(line || undefined, optInt(run));
  }

  @Get('escapes')
  escapes(@Query('run') run?: string) {
    return this.production.escapes(optInt(run));
  }

  @Get('states/:station')
  states(@Param('station') station: string, @Query('run') run?: string) {
    return this.production.states(station, optInt(run));
  }
}
