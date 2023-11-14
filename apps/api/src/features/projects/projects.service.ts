import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  Logger,
  LoggerService,
  NotFoundException,
} from '@nestjs/common'
import { CreateProjectDto } from './dto/create-project.dto'
import { UpdateProjectDto } from './dto/update-project.dto'
import { ToggleProjectStatusDto } from './dto/toggle-project-status.dto'
import { InjectModel } from '@nestjs/mongoose'
import { Project, TProjectDoc } from './schema/project.schema'
import { FilterQuery, MergeType, Model, PopulateOptions } from 'mongoose'
import { IActiveUser } from 'src/iam/interfaces/i-active-user'
import { FactoryUtils } from 'src/common/services/factory.utils'
import { EPremiumSubscribers } from 'src/iam/enums/e-roles.enum'
import { PaymentRequiredException } from 'src/common/exceptions/payment-require.exception'
import { UpdateUserDto } from 'src/iam/users/dto/update-user.dto'
import { UsersService } from 'src/iam/users/users.service'
import { EProjectTypes } from './enums/e-project-types.enum'
import { EProjectTypeBehavior } from './enums/e-project-type-behavior.enum'
import { TTodoDoc } from '../todos/schema/todo.schema'

@Injectable()
export class ProjectsService {
  private readonly MAX_STANDARD_SUBSCRIBER_PROJECTS = 12
  private readonly MAX_GUEST_SUBSCRIBER_PROJECTS = 3

  private readonly logger: LoggerService = new Logger(ProjectsService.name)

  constructor(
    @InjectModel(Project.name)
    private readonly projectModel: Model<Project>,

    private readonly userService: UsersService,

    private readonly factoryUtils: FactoryUtils,
  ) {}

  async create(createProjectDto: CreateProjectDto, activeUser: IActiveUser) {
    const totalProjects = activeUser.totalProjects

    try {
      // confirm is user is creating a new root project
      const whoIs = this.factoryUtils.whoIs(activeUser)

      if (
        (!createProjectDto?.projectType ||
          createProjectDto?.projectType === EProjectTypes.ROOT) &&
        (createProjectDto?.rootParentId || createProjectDto?.subParentId)
      ) {
        this.logger.warn(
          `User ${whoIs} is trying to create a new root project but has also supplied a ${
            createProjectDto?.rootParentId
              ? 'root parent id'
              : 'sub root parent id'
          }`,
        )

        throw new BadRequestException(
          `Looks like you are creating a new project? However your request includes dependencies to another project? Do you intend to create a sub-project?`,
        )
      }

      // ensure  a sub-project has parent project id
      if (
        createProjectDto?.projectType === EProjectTypes.SUB_PROJECT &&
        !createProjectDto?.rootParentId
      ) {
        this.logger.warn(
          `User ${whoIs} is creating a sub project without it's id`,
        )

        throw new BadRequestException(`A sub-project requires it's parent id`)
      }
      // get user total projects & check if has reached max limit

      const userSubscription = activeUser.baseRole

      if (
        userSubscription === EPremiumSubscribers.GUEST_USER ||
        userSubscription === EPremiumSubscribers.STANDARD_USER
      ) {
        const guest = EPremiumSubscribers.GUEST_USER
        const standard = EPremiumSubscribers.STANDARD_USER

        const maxProjects = {
          [guest]: this.MAX_GUEST_SUBSCRIBER_PROJECTS,
          [standard]: this.MAX_STANDARD_SUBSCRIBER_PROJECTS,
        }

        const newTotalPr = totalProjects + 1

        if (newTotalPr > maxProjects[userSubscription]) {
          this.logger.warn(
            `User ${whoIs} is trying to add more projects beyond the max limit`,
          )

          throw new PaymentRequiredException(
            'Please upgrade your account to enjoy more projects',
          )
        }
      }
      // update user with totalProjects - we can use transactions
      await this.updateTotalProjects(
        totalProjects,
        activeUser,
        createProjectDto,
      )

      let message: string
      let foundProject: MergeType<
        TProjectDoc,
        {
          createdAt: string
          updatedAt: string
        }
      >
      // find parent project user is trying to create
      if (createProjectDto?.rootParentId) {
        foundProject = await this.projectModel.findById(
          createProjectDto?.rootParentId,
        )

        // @TODO: check - don't add tasks to normal/non-leafy projects

        if (
          foundProject &&
          foundProject.projectTypeBehavior === EProjectTypeBehavior.LEAFY
        ) {
          const withTasks = await foundProject.populate<{ tasks: TTodoDoc }>(
            'tasks',
          )

          if (withTasks?.tasks) {
            message = `The root project you are trying to associate this sub-projects have tasks associated at its root. Please, update all these tasks to associate them with either this sub-project or other relevant sub-projects & convert is to normal`
          } else {
            // if no tasks, update leafy to normal
            withTasks.projectTypeBehavior = EProjectTypeBehavior.NORMAL
            await withTasks.save()
          }
        }
      }

      // can now create a new project
      let newProject: TProjectDoc

      if (!foundProject) {
        newProject = await this.projectModel.create(createProjectDto)
      }

      // reusing the handle
      if (foundProject) {
        Object.entries(createProjectDto).forEach(([key, value]) => {
          foundProject[key] = value
        })

        //clean: remove unnecessary fields
        foundProject.id = undefined
        foundProject._id = undefined
        foundProject.createdAt = undefined
        foundProject.updatedAt = undefined
        foundProject.__v = undefined

        foundProject.isNew = true
        newProject = await foundProject.save()
      }

      // always populate
      newProject = await newProject.populate(this.populateConfigs())

      return {
        message: message || 'A new project was successfully created',
        data: newProject,
      }
    } catch (error) {
      this.logger.warn(error.message)
      this.logger.verbose(error)

      // handler bad request
      if (error instanceof BadRequestException) {
        throw new BadRequestException(error.message)
      }

      // handle payment exceptions request
      if (error instanceof PaymentRequiredException) {
        throw new PaymentRequiredException(error.message)
      }

      // handle not found exceptions request
      if (error instanceof NotFoundException) {
        throw new NotFoundException(`Failed to create a new project`)
      }

      // handle forbidden exceptions request
      if (error instanceof ForbiddenException) {
        throw new ForbiddenException(`Failed to create a new project`)
      }

      // handle validations
      if (error instanceof Error && error.name === 'Validations') {
        // rollback updating total projects
        await this.updateTotalProjects(
          totalProjects,
          activeUser,
          createProjectDto,
          false,
        )

        throw new BadRequestException(error.message)
      }

      // handle conflict
      if (error.code === 11000) {
        // rollback updating total projects
        await this.updateTotalProjects(
          totalProjects,
          activeUser,
          createProjectDto,
          false,
        )

        const message = this.factoryUtils.autoGenerateDuplicateMessage(error)

        throw new ConflictException(message || 'Failed to create a new project')
      }

      // handle default - unknown error
      throw new InternalServerErrorException(
        'Server failed to process your request, please try again later',
      )
    }
  }

  findAll(filters: FilterQuery<Project>, activeUser: IActiveUser) {
    // aggregation
    // or just find all
    return `This action returns all Projects`
  }

  findOne(ProjectId: string, activeUser: IActiveUser) {
    return `This action returns a #${ProjectId} Project`
  }

  update(
    ProjectId: string,
    updateProjectDto: Partial<UpdateProjectDto | ToggleProjectStatusDto>,
    activeUser: IActiveUser,
  ) {
    return `This action updates a #${ProjectId} Project`
  }

  toggleStatus(
    ProjectId: string,
    toggleStatusDto: ToggleProjectStatusDto,
    activeUser: IActiveUser,
  ) {
    return `toggleStatus`
  }

  remove(ProjectId: string, activeUser: IActiveUser) {
    return `This action removes a #${ProjectId} Project`
  }

  /**
   * ---------------------------------------
   *
   *                 HELPERS
   *
   * ---------------------------------------
   *
   */

  /**
   * Updates user total projects
   * - Can also be used to rollback updates if create error occurs
   *
   * @param totalProjects
   * @param activeUser
   * @param add
   */
  private async updateTotalProjects(
    totalProjects: number,
    activeUser: IActiveUser,
    dto: CreateProjectDto,
    add: boolean = true,
  ) {
    if (dto.projectType !== EProjectTypes.ROOT) return

    const userUpdateDto = {
      totalProjects: totalProjects + (add ? 1 : 0),
    } as UpdateUserDto

    await this.userService.update(
      activeUser.sub.toString(),
      userUpdateDto,
      activeUser,
    )
  }

  /**
   * Pre configure populate fields
   * @returns
   */
  private populateConfigs(): PopulateOptions[] {
    return [
      { path: 'dependsOn' },
      { path: 'rootParentId' },
      { path: 'subParentId' },
      { path: 'tasks' },
      { path: 'tasks.parentId' },
      { path: 'tasks.subParentId' },
      { path: 'tasks.iconId' },
      { path: 'tasks.userId' },
    ]
  }
}
