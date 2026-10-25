export class ApiResponse<T = any> {
  success: boolean;
  data?: T;
  message: string;
  code: number;
  timestamp: number;

  constructor(data?: T, message: string = 'Success', code: number = 200) {
    this.success = true;
    this.data = data;
    this.message = message;
    this.code = code;
    this.timestamp = Date.now();
  }

  static ok<T>(data?: T, message?: string): ApiResponse<T> {
    return new ApiResponse(data, message, 200);
  }

  static created<T>(data?: T, message: string = 'Created'): ApiResponse<T> {
    return new ApiResponse(data, message, 201);
  }
}

export class ApiError<T = any> {
  success: boolean;
  data?: T;
  message: string;
  code: number;
  timestamp: number;

  constructor(message: string = 'Error', code: number = 400, data?: T) {
    this.success = false;
    this.data = data;
    this.message = message;
    this.code = code;
    this.timestamp = Date.now();
  }

  static badRequest(message: string = 'Bad Request', data?: any): ApiError {
    return new ApiError(message, 400, data);
  }

  static unauthorized(message: string = 'Unauthorized'): ApiError {
    return new ApiError(message, 401);
  }

  static forbidden(message: string = 'Forbidden'): ApiError {
    return new ApiError(message, 403);
  }

  static notFound(message: string = 'Not Found'): ApiError {
    return new ApiError(message, 404);
  }

  static internal(message: string = 'Internal Server Error'): ApiError {
    return new ApiError(message, 500);
  }
}
