import { IsOptional, IsString } from 'class-validator';
import { PaginationDto } from '../../../common/dto/pagination.dto';

export class QueryDevicesDto extends PaginationDto {
  @IsOptional()
  @IsString()
  projectId?: string;
}
